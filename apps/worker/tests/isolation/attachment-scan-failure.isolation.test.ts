/**
 * Isolation test for handleAttachmentScanFailure (ADR-012 Phase D, Stage 3,
 * spec R5). Real Postgres connection, RLS + app_user enforced, no mocking
 * of @platform/db -- specifically written against a real database because
 * this is exactly the kind of path (a new AuditAction value) that silently
 * broke in Phase C (B1: the admin_audit_log CHECK constraint was never
 * extended, and every mocked unit test around that worker missed it).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  workflows,
  workflowStates,
  attachments,
  workflowEvents,
  adminAuditLog,
  files,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import { handleAttachmentScanFailure } from "../../src/attachment-scan-failure.js";

const TENANT = "aabbccdd-0000-4000-a000-000000000901";
const BOUND_FILE_ID = "11111111-1111-4000-8000-000000000001";
const UNBOUND_FILE_ID = "22222222-2222-4000-8000-000000000002";

let workflowId: string;
let ticketId: string;
let boundAttachmentId: string;
let unboundAttachmentId: string;

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Attachment Scan Failure Tenant",
    slug: `attach-scan-fail-${TENANT}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `attachment_scan_failure_test_${Date.now()}`,
    plural: "attachment_scan_failure_tests",
    allowCustomFields: true,
  });

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId: entityType.id,
      name: "Attachment Scan Failure Workflow",
      initialState: "open",
    })
    .returning({ id: workflows.id });
  workflowId = workflow!.id;

  await db.insert(workflowStates).values({
    tenantId: TENANT,
    workflowId,
    name: "open",
    label: "Open",
    sortOrder: 0,
  });

  const ticket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "creator",
    workflowId,
    currentState: "open",
  });
  ticketId = ticket.id;

  await db.insert(files).values([
    {
      id: BOUND_FILE_ID,
      tenantId: TENANT,
      moduleSlug: "third-party-attachments",
      originalName: "x.txt",
      storageKey: `${TENANT}/third-party-attachments/x.txt`,
      mimeType: "text/plain",
      sizeBytes: 5,
      scanStatus: "quarantined",
      uploadedBy: "creator",
    },
    {
      id: UNBOUND_FILE_ID,
      tenantId: TENANT,
      moduleSlug: "third-party-attachments",
      originalName: "y.txt",
      storageKey: `${TENANT}/third-party-attachments/y.txt`,
      mimeType: "text/plain",
      sizeBytes: 5,
      scanStatus: "quarantined",
      uploadedBy: "creator",
    },
  ]);

  const [bound] = await db
    .insert(attachments)
    .values({
      tenantId: TENANT,
      ticketId,
      boundAt: new Date(),
      uploadedBy: "api_key",
      actingPersonId: "creator",
      declaredFilename: "x.txt",
      declaredSizeBytes: 5,
      declaredMimeType: "text/plain",
      uploadTokenHash: "unused",
      uploadExpiresAt: new Date(Date.now() + 60_000),
      filesId: BOUND_FILE_ID,
      status: "uploaded",
    })
    .returning({ id: attachments.id });
  boundAttachmentId = bound!.id;

  const [unbound] = await db
    .insert(attachments)
    .values({
      tenantId: TENANT,
      uploadedBy: "api_key",
      actingPersonId: "creator",
      declaredFilename: "y.txt",
      declaredSizeBytes: 5,
      declaredMimeType: "text/plain",
      uploadTokenHash: "unused2",
      uploadExpiresAt: new Date(Date.now() + 60_000),
      filesId: UNBOUND_FILE_ID,
      status: "uploaded",
    })
    .returning({ id: attachments.id });
  unboundAttachmentId = unbound!.id;
});

afterAll(async () => {
  await db.delete(attachments).where(eq(attachments.tenantId, TENANT));
  await db.delete(files).where(eq(files.tenantId, TENANT));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
});

describe("handleAttachmentScanFailure", () => {
  it("writes a system note and a real audit log row for a quarantined bound attachment", async () => {
    await handleAttachmentScanFailure(TENANT, BOUND_FILE_ID, "quarantined");

    const [note] = await db
      .select()
      .from(workflowEvents)
      .where(
        sql`${workflowEvents.instanceId} = ${ticketId} AND metadata->>'type' = 'system_note'`,
      );
    expect(note).toBeDefined();
    expect(note?.metadata).toMatchObject({
      type: "system_note",
      reason: "attachment_quarantined",
      attachmentId: boundAttachmentId,
    });

    const [audit] = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.resourceId, ticketId));
    expect(audit?.action).toBe("attachment.quarantined");
  });

  it("writes attachment.scan_failed without violating the audit CHECK constraint", async () => {
    await handleAttachmentScanFailure(TENANT, BOUND_FILE_ID, "scan_failed");

    const rows = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.resourceId, ticketId));
    expect(rows.some((r) => r.action === "attachment.scan_failed")).toBe(true);
  });

  it("is a no-op for an attachment that was never bound to a ticket", async () => {
    await handleAttachmentScanFailure(TENANT, UNBOUND_FILE_ID, "quarantined");

    const rows = await db
      .select()
      .from(adminAuditLog)
      .where(sql`metadata->>'attachmentId' = ${unboundAttachmentId}`);
    expect(rows).toHaveLength(0);
  });
});
