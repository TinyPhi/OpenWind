/**
 * ADR-012 Phase G, spec R9/R10 -- tenant-purge must:
 *   R9: anonymize (never delete) that tenant's admin_audit_log rows —
 *       person-identifying fields replaced with a placeholder, everything
 *       else (action/resourceType/resourceId/createdAt) preserved.
 *   R10: delete (not anonymize) that tenant's idempotency_keys rows outright
 *        — response_body can contain full ticket/comment PII, no
 *        operational-history reason to keep a placeholder row.
 *
 * Uses a real Postgres database (no mocks on @platform/db), matching the
 * sibling tenant-purge.isolation.test.ts convention — only BullMQ is mocked
 * so the processor can be invoked directly against a synthetic job.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  adminAuditLog,
  idempotencyKeys,
  apiKeys,
} from "@platform/db";

let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock("../../src/queues.js", () => ({ connection: {} }));

const TENANT_ID = "ffffffff-b000-4000-a000-000000000038";
const RESOURCE_ID = "ffffffff-b000-4000-a000-000000000039";
const PERSON_ID = "phase-g-purge-test-person";

let userAuditRowId: string;
let apiKeyAuditRowId: string;

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "Phase G purge audit/idempotency tenant",
      slug: `phase-g-purge-${Date.now()}`,
      status: "deleted",
    })
    .onConflictDoNothing();

  // actorType 'user' -- actorId IS a person identifier, must be anonymized.
  const [userRow] = await db
    .insert(adminAuditLog)
    .values({
      tenantId: TENANT_ID,
      actorId: PERSON_ID,
      actorType: "user",
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action: "created",
    })
    .returning({ id: adminAuditLog.id });
  if (!userRow) throw new Error("admin_audit_log insert (user) failed");
  userAuditRowId = userRow.id;

  // actorType 'api_key' with an actingPersonId -- actorId is an application
  // identity (NOT anonymized), actingPersonId IS a person identifier (IS
  // anonymized), per the spec's distinction.
  const [apiKeyRow] = await db
    .insert(adminAuditLog)
    .values({
      tenantId: TENANT_ID,
      actorId: "11111111-1111-4111-1111-111111111111",
      actorType: "api_key",
      actingPersonId: PERSON_ID,
      resourceType: "ticket",
      resourceId: RESOURCE_ID,
      action: "comment.created",
    })
    .returning({ id: adminAuditLog.id });
  if (!apiKeyRow) throw new Error("admin_audit_log insert (api_key) failed");
  apiKeyAuditRowId = apiKeyRow.id;

  await db.insert(apiKeys).values({
    id: "11111111-1111-4111-1111-111111111111",
    tenantId: TENANT_ID,
    name: "Phase G purge test key",
    keyHash: `hash-${Date.now()}`,
    scopes: [],
  });

  await db.insert(idempotencyKeys).values({
    tenantId: TENANT_ID,
    apiKeyId: "11111111-1111-4111-1111-111111111111",
    actingPersonId: PERSON_ID,
    idempotencyKey: "phase-g-purge-test-key",
    contentHash: "deadbeef",
    responseStatus: 201,
    responseBody: { data: { id: "some-ticket-id" } },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  await import("../../src/tenant-purge.js");
});

afterAll(async () => {
  await db.delete(apiKeys).where(eq(apiKeys.tenantId, TENANT_ID));
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_ID));
  await db
    .delete(idempotencyKeys)
    .where(eq(idempotencyKeys.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("tenant-purge: admin_audit_log anonymization + idempotency_keys deletion (ADR-012 Phase G)", () => {
  it("anonymizes admin_audit_log rows in place rather than deleting them", async () => {
    expect(capturedProcessor).not.toBeNull();

    await capturedProcessor!({
      id: "phase-g-purge-audit-idempotency-job",
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { tenantId: TENANT_ID },
    });

    const rows = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.tenantId, TENANT_ID));

    // Both seeded rows still exist -- anonymized, not deleted -- plus the
    // purge job's own "purge.completed" entry it writes for every purge
    // (tenant-purge.ts, actorType 'system', not a person -- left alone).
    expect(rows).toHaveLength(3);

    const userRow = rows.find((r) => r.id === userAuditRowId);
    expect(userRow?.actorId).toBe("[REDACTED]");
    expect(userRow?.actorType).toBe("user");
    expect(userRow?.resourceType).toBe("ticket");
    expect(userRow?.resourceId).toBe(RESOURCE_ID);
    expect(userRow?.action).toBe("created");

    const apiKeyRow = rows.find((r) => r.id === apiKeyAuditRowId);
    // actorId on an api_key row is an application identity, not a person --
    // left untouched.
    expect(apiKeyRow?.actorId).toBe("11111111-1111-4111-1111-111111111111");
    expect(apiKeyRow?.actingPersonId).toBe("[REDACTED]");
    expect(apiKeyRow?.action).toBe("comment.created");

    const purgeCompletedRow = rows.find((r) => r.action === "purge.completed");
    expect(purgeCompletedRow?.actorType).toBe("system");
    expect(purgeCompletedRow?.actorId).toBe("system");
  });

  it("deletes idempotency_keys rows outright, not anonymizes them", async () => {
    const rows = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.tenantId, TENANT_ID));

    expect(rows).toHaveLength(0);
  });

  it("marks the tenant row as purged", async () => {
    const [tenantRow] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .limit(1);
    expect(tenantRow?.status).toBe("purged");
  });
});
