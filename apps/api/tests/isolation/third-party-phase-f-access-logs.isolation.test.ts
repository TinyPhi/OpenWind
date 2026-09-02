/**
 * Isolation tests for ADR-012 Phase F, spec R3/AC5 — verified together (not
 * per-phase) across comment-post, sub-ticket-create, attachment-reference,
 * and transition: a denied attempt produces zero new `workflow_events` rows
 * and exactly one `admin_audit_log` row. Also covers the admin
 * third-party-access-logs route itself (tenant isolation, filtering,
 * outcome classification).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq, and } from "drizzle-orm";
import {
  db,
  tenants,
  workflowEvents,
  adminAuditLog,
  attachments,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import {
  createWorkflow,
  addWorkflowState,
  addWorkflowTransition,
} from "@platform/workflow-engine";
import type { EntityType } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { createThirdPartyCommentHandler } from "../../src/routes/third-party/comments.js";
import { createThirdPartyChildHandler } from "../../src/routes/third-party/children.js";
import { executeThirdPartyTransitionHandler } from "../../src/routes/third-party/transitions.js";
import { getThirdPartyAccessLogsHandler } from "../../src/routes/admin/third-party-access-logs.js";
import { writeAuditEntry } from "@platform/audit";
import { withTenantContext } from "@platform/db";

const TENANT = "bbccddee-0000-4000-b000-000000000f01";
const OTHER_TENANT = "bbccddee-0000-4000-b000-000000000f02";
const API_KEY_ID = "77777777-7777-4777-7777-777777777777";

let entityType: EntityType;
let workflowId: string;
let openToProcessingId: string;
let noAccessCommentTicketId: string;
let noAccessChildTicketId: string;
let attachmentRefTicketId: string;
let transitionTicketId: string;
let otherTenantAttachmentId: string;

const CREATOR = "phase-f-creator";
const NO_ACCESS_PERSON = "phase-f-no-access";

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT, name: "Phase F Tenant", slug: `phase-f-${TENANT}` },
    {
      id: OTHER_TENANT,
      name: "Phase F Other Tenant",
      slug: `phase-f-other-${OTHER_TENANT}`,
    },
  ]);

  entityType = await createEntityType(db, null, {
    name: `phase_f_access_logs_test_${Date.now()}`,
    plural: "phase_f_access_logs_tests",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `phase_f_workflow_${Date.now()}`,
    initialState: "open",
  });
  workflowId = workflow.id;
  const caller = { userId: "test-actor", isGlobalAdmin: true };

  await addWorkflowState(db, TENANT, workflowId, caller, {
    name: "open",
    label: "Open",
    isTerminal: false,
    sortOrder: 0,
  });
  await addWorkflowState(db, TENANT, workflowId, caller, {
    name: "processing",
    label: "Processing",
    isTerminal: false,
    sortOrder: 1,
  });
  const openToProcessing = await addWorkflowTransition(
    db,
    TENANT,
    workflowId,
    caller,
    { fromState: "open", toState: "processing" },
  );
  openToProcessingId = openToProcessing.id;

  const commentTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  noAccessCommentTicketId = commentTicket.id;

  const childTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  noAccessChildTicketId = childTicket.id;

  const attachmentRefTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  attachmentRefTicketId = attachmentRefTicket.id;

  const transitionTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  transitionTicketId = transitionTicket.id;

  const [otherAttachment] = await db
    .insert(attachments)
    .values({
      tenantId: OTHER_TENANT,
      uploadedBy: "api_key",
      actingPersonId: CREATOR,
      declaredFilename: "x.txt",
      declaredSizeBytes: 1,
      declaredMimeType: "text/plain",
      uploadTokenHash: "unused-phase-f",
      uploadExpiresAt: new Date(Date.now() + 60_000),
      status: "uploaded",
    })
    .returning({ id: attachments.id });
  otherTenantAttachmentId = otherAttachment!.id;
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, OTHER_TENANT]));
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp(actingPersonId: string) {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: `apikey:${API_KEY_ID}`,
      tenantId: TENANT,
      roles: [
        "entity:ticket:comment",
        "entity:ticket:subticket",
        "entity:ticket:transition",
      ],
      email: "",
      displayName: "API Key",
      orgId: "org-fff",
    });
    c.set("actingPerson", {
      userId: actingPersonId,
      email: `${actingPersonId}@example.com`,
      displayName: actingPersonId,
      orgId: "org-fff",
    });
    await next();
  });
  app.post("/tickets/:id/comments", ...createThirdPartyCommentHandler);
  app.post("/tickets/:id/children", ...createThirdPartyChildHandler);
  app.post("/tickets/:id/transitions", ...executeThirdPartyTransitionHandler);
  return app;
}

async function eventCount(ticketId: string): Promise<number> {
  const rows = await db
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.instanceId, ticketId));
  return rows.length;
}

async function auditRows(ticketId: string, action: string) {
  return db
    .select()
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.tenantId, TENANT),
        eq(adminAuditLog.resourceId, ticketId),
        eq(adminAuditLog.action, action),
      ),
    );
}

describe("Phase F, spec R3/AC5 — denied attempts across all four action types", () => {
  it("comment-post: denied attempt produces zero workflow_events rows and exactly one admin_audit_log row", async () => {
    const before = await eventCount(noAccessCommentTicketId);
    const app = makeApp(NO_ACCESS_PERSON);
    const res = await app.request(
      `/tickets/${noAccessCommentTicketId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "should be denied" }),
      },
    );
    expect(res.status).toBe(404);
    expect(await eventCount(noAccessCommentTicketId)).toBe(before);
    const rows = await auditRows(
      noAccessCommentTicketId,
      "comment.access_denied",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actingPersonId).toBe(NO_ACCESS_PERSON);
  });

  it("sub-ticket-create: denied attempt produces zero workflow_events rows and exactly one admin_audit_log row", async () => {
    const before = await eventCount(noAccessChildTicketId);
    const app = makeApp(NO_ACCESS_PERSON);
    const res = await app.request(
      `/tickets/${noAccessChildTicketId}/children`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entityTypeId: entityType.id, fields: {} }),
      },
    );
    expect(res.status).toBe(404);
    expect(await eventCount(noAccessChildTicketId)).toBe(before);
    const rows = await auditRows(noAccessChildTicketId, "child.access_denied");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actingPersonId).toBe(NO_ACCESS_PERSON);
  });

  it("attachment-reference: a cross-tenant attachment id is denied, produces zero workflow_events rows, and does not also record a spurious comment.created row", async () => {
    const before = await eventCount(attachmentRefTicketId);
    const app = makeApp(CREATOR);
    const res = await app.request(
      `/tickets/${attachmentRefTicketId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "referencing a cross-tenant attachment",
          attachmentIds: [otherTenantAttachmentId],
        }),
      },
    );
    expect(res.status).toBe(404);
    expect(await eventCount(attachmentRefTicketId)).toBe(before);

    const deniedRows = await auditRows(
      attachmentRefTicketId,
      "attachment.reference_denied",
    );
    expect(deniedRows).toHaveLength(1);

    const createdRows = await auditRows(
      attachmentRefTicketId,
      "comment.created",
    );
    expect(createdRows).toHaveLength(0);
  });

  it("transition: denied attempt produces zero workflow_events rows and exactly one admin_audit_log row", async () => {
    const before = await eventCount(transitionTicketId);
    const app = makeApp(NO_ACCESS_PERSON);
    const res = await app.request(
      `/tickets/${transitionTicketId}/transitions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transitionId: openToProcessingId }),
      },
    );
    expect(res.status).toBe(404);
    expect(await eventCount(transitionTicketId)).toBe(before);
    const rows = await auditRows(
      transitionTicketId,
      "transition.access_denied",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actingPersonId).toBe(NO_ACCESS_PERSON);
  });

  it("an allowed comment-post produces exactly one workflow_events row and one comment.created admin_audit_log row (baseline, spec R1)", async () => {
    const before = await eventCount(noAccessCommentTicketId);
    const app = makeApp(CREATOR);
    const res = await app.request(
      `/tickets/${noAccessCommentTicketId}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "allowed comment" }),
      },
    );
    expect(res.status).toBe(201);
    expect(await eventCount(noAccessCommentTicketId)).toBe(before + 1);
    const rows = await auditRows(noAccessCommentTicketId, "comment.created");
    expect(rows).toHaveLength(1);
  });
});

describe("GET /admin/third-party-access-logs — spec AC2, tenant isolation", () => {
  function makeAdminApp(tenantId: string) {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        userId: "admin-user",
        tenantId,
        roles: ["admin"],
        email: "admin@example.com",
        displayName: "Admin",
        orgId: "org-fff",
      });
      await next();
    });
    app.get(
      "/admin/third-party-access-logs",
      ...getThirdPartyAccessLogsHandler,
    );
    return app;
  }

  it("returns rows for the caller's own tenant, filterable by ticketId and outcome", async () => {
    const app = makeAdminApp(TENANT);
    const res = await app.request(
      `/admin/third-party-access-logs?ticketId=${noAccessCommentTicketId}&outcome=denied`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ ticketId: string; outcome: string; action: string }>;
    };
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    for (const row of body.data) {
      expect(row.ticketId).toBe(noAccessCommentTicketId);
      expect(row.outcome).toBe("denied");
    }
  });

  it("never returns another tenant's rows regardless of query params", async () => {
    const app = makeAdminApp(OTHER_TENANT);
    const res = await app.request(
      `/admin/third-party-access-logs?ticketId=${noAccessCommentTicketId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });

  // Bug: createEntity's audit hook used to stamp actor_id with the acting
  // person's (non-uuid, e.g. Zitadel numeric) id instead of the api key's
  // uuid for actor_type='api_key' rows -- see engine.ts's fireEntityAuditHook
  // fix. Legacy rows written before that fix still exist in production and
  // must not crash this endpoint: Postgres rejects a non-uuid literal
  // compared against api_keys.id (a uuid column) for the WHOLE query, not
  // just that one row, so a single bad row previously 500'd the entire list.
  it("tolerates a legacy row whose actor_id is not a valid uuid instead of 500ing", async () => {
    await withTenantContext(TENANT, (tx) =>
      writeAuditEntry(tx, {
        tenantId: TENANT,
        actorId: "378676050449661954",
        actorType: "api_key",
        actingPersonId: "378676050449661954",
        resourceType: "ticket",
        resourceId: noAccessCommentTicketId,
        action: "comment.created",
        beforeSnapshot: null,
        afterSnapshot: null,
      }),
    );

    const app = makeAdminApp(TENANT);
    const res = await app.request(
      `/admin/third-party-access-logs?ticketId=${noAccessCommentTicketId}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ applicationName: string | null; applicationKeyId: string }>;
    };
    const legacyRow = body.data.find(
      (r) => r.applicationKeyId === "378676050449661954",
    );
    expect(legacyRow).toBeDefined();
    expect(legacyRow?.applicationName).toBeNull();
  });

  it("rejects a non-admin caller", async () => {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        userId: "agent-user",
        tenantId: TENANT,
        roles: ["agent"],
        email: "agent@example.com",
        displayName: "Agent",
        orgId: "org-fff",
      });
      await next();
    });
    app.get(
      "/admin/third-party-access-logs",
      ...getThirdPartyAccessLogsHandler,
    );
    const res = await app.request("/admin/third-party-access-logs");
    expect(res.status).toBe(403);
  });
});
