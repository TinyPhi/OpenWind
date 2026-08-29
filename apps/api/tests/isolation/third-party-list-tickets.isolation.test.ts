/**
 * Isolation tests for GET /api/v1/workflows/:workflowId/tickets
 * (docs/specs/third-party-api-list-my-tickets.md).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq, and, sql } from "drizzle-orm";
import { db, tenants, entityInstances } from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import { createWorkflow, addWorkflowState } from "@platform/workflow-engine";
import type { EntityType } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { listThirdPartyTicketsHandler } from "../../src/routes/third-party/list-tickets.js";
import { getThirdPartyTicketHandler } from "../../src/routes/third-party/tickets.js";

const TENANT = "ffffffff-0000-4000-f000-000000000f11";
const OTHER_TENANT = "ffffffff-0000-4000-f000-000000000f12";

const MAIN_PERSON = "third-party-list-tickets-main";
const WORKFLOW_ADMIN = "third-party-list-tickets-admin";
const PAGINATION_PERSON = "third-party-list-tickets-pagination";

let entityType: EntityType;
let workflowId: string;
let creatorTicketId: string;
let assigneeTicketId: string;
let aclGrantedTicketId: string;
let aclBadLevelTicketId: string;
let unrelatedTicketId: string;
let adminOnlyTicketId: string;
let otherTenantWorkflowId: string;
let paginationWorkflowId: string;
const paginationTicketIds: string[] = [];

async function grantAccess(ticketId: string, userId: string, level: string) {
  await db
    .update(entityInstances)
    .set({
      fields: sql`jsonb_set(
        jsonb_set(
          fields,
          '{__accessUsers}',
          CASE
            WHEN jsonb_typeof(COALESCE(fields->'__accessUsers', 'null'::jsonb)) = 'object'
            THEN fields->'__accessUsers'
            ELSE '{}'::jsonb
          END
        ),
        ARRAY['__accessUsers', ${userId}::text],
        jsonb_build_object('level', to_jsonb(${level}::text), 'tag', 'mention')
      )`,
    })
    .where(
      and(
        eq(entityInstances.id, ticketId),
        eq(entityInstances.tenantId, TENANT),
      ),
    );
}

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT, name: "3P List Tenant", slug: `3p-list-${TENANT}` },
    {
      id: OTHER_TENANT,
      name: "3P List Other Tenant",
      slug: `3p-list-other-${OTHER_TENANT}`,
    },
  ]);

  entityType = await createEntityType(db, null, {
    name: `third_party_list_test_${Date.now()}`,
    plural: "third_party_list_tests",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `third_party_list_workflow_${Date.now()}`,
    initialState: "open",
  });
  workflowId = workflow.id;
  await addWorkflowState(
    db,
    TENANT,
    workflowId,
    { userId: "test-actor", isGlobalAdmin: true },
    { name: "open", label: "Open", isTerminal: false, sortOrder: 0 },
  );

  await db.execute(
    sql`UPDATE workflows SET assigned_to = array_append(assigned_to, ${WORKFLOW_ADMIN}) WHERE id = ${workflowId}::uuid`,
  );

  const creatorTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: MAIN_PERSON,
    workflowId,
    currentState: "open",
  });
  creatorTicketId = creatorTicket.id;

  const assigneeTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    assignedTo: MAIN_PERSON,
    workflowId,
    currentState: "open",
  });
  assigneeTicketId = assigneeTicket.id;

  const aclGrantedTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  aclGrantedTicketId = aclGrantedTicket.id;
  await grantAccess(aclGrantedTicketId, MAIN_PERSON, "read_only");

  // A grant with a level hasEntityAccess doesn't recognize -- proves list/get
  // parity: must NOT appear in the list, matching GET /tickets/:id's own 404.
  const aclBadLevelTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  aclBadLevelTicketId = aclBadLevelTicket.id;
  await grantAccess(aclBadLevelTicketId, MAIN_PERSON, "some_bogus_level");

  const unrelatedTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  unrelatedTicketId = unrelatedTicket.id;

  const adminOnlyTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  adminOnlyTicketId = adminOnlyTicket.id;

  // Separate workflow + entity type just for pagination, to keep counts exact.
  const paginationEntityType = await createEntityType(db, null, {
    name: `third_party_list_pagination_test_${Date.now()}`,
    plural: "third_party_list_pagination_tests",
    allowCustomFields: true,
  });
  const paginationWorkflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: paginationEntityType.id,
    name: `third_party_list_pagination_workflow_${Date.now()}`,
    initialState: "open",
  });
  paginationWorkflowId = paginationWorkflow.id;
  await addWorkflowState(
    db,
    TENANT,
    paginationWorkflowId,
    { userId: "test-actor", isGlobalAdmin: true },
    { name: "open", label: "Open", isTerminal: false, sortOrder: 0 },
  );
  for (let i = 0; i < 3; i++) {
    const t = await createEntity(db, TENANT, {
      entityTypeId: paginationEntityType.id,
      fields: {},
      createdBy: PAGINATION_PERSON,
      workflowId: paginationWorkflowId,
      currentState: "open",
    });
    paginationTicketIds.push(t.id);
    // Ensure distinct createdAt ordering for deterministic cursor pagination.
    await new Promise((r) => setTimeout(r, 5));
  }

  const otherEntityType = await createEntityType(db, null, {
    name: `third_party_list_other_test_${Date.now()}`,
    plural: "third_party_list_other_tests",
    allowCustomFields: true,
  });
  const otherWorkflow = await createWorkflow(db, OTHER_TENANT, "test-actor", {
    entityTypeId: otherEntityType.id,
    name: `third_party_list_other_workflow_${Date.now()}`,
    initialState: "open",
  });
  otherTenantWorkflowId = otherWorkflow.id;
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, OTHER_TENANT]));
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp(
  actingPersonId: string,
  scopes: string[] = ["entity:ticket:read"],
) {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: "apikey:88888888-8888-4888-8888-888888888888",
      tenantId: TENANT,
      roles: scopes,
      email: "",
      displayName: "API Key 88888888",
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
  app.get("/workflows/:workflowId/tickets", ...listThirdPartyTicketsHandler);
  app.get("/tickets/:id", ...getThirdPartyTicketHandler);
  return app;
}

async function listTickets(app: Hono<Vars>, wfId: string, query = "") {
  return app.request(`/workflows/${wfId}/tickets${query}`);
}

describe("GET /api/v1/workflows/:workflowId/tickets", () => {
  it("includes a ticket the acting person created", async () => {
    const app = makeApp(MAIN_PERSON);
    const res = await listTickets(app, workflowId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((t) => t.id)).toContain(creatorTicketId);
  });

  it("includes a ticket the acting person is assigned to", async () => {
    const app = makeApp(MAIN_PERSON);
    const res = await listTickets(app, workflowId);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((t) => t.id)).toContain(assigneeTicketId);
  });

  it("includes a ticket with a recognized-level __accessUsers grant", async () => {
    const app = makeApp(MAIN_PERSON);
    const res = await listTickets(app, workflowId);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((t) => t.id)).toContain(aclGrantedTicketId);
  });

  it("never includes the internal __accessUsers ACL object in any returned ticket's fields", async () => {
    const app = makeApp(MAIN_PERSON);
    const res = await listTickets(app, workflowId);
    const body = (await res.json()) as {
      data: Array<{ id: string; fields: Record<string, unknown> }>;
    };
    const grantedTicket = body.data.find((t) => t.id === aclGrantedTicketId);
    expect(grantedTicket).toBeDefined();
    expect(grantedTicket?.fields).not.toHaveProperty("__accessUsers");
  });

  it("excludes a ticket the acting person has no relationship to", async () => {
    const app = makeApp(MAIN_PERSON);
    const res = await listTickets(app, workflowId);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((t) => t.id)).not.toContain(unrelatedTicketId);
  });

  it("list/get parity: excludes a ticket with a non-standard-level grant, matching GET /tickets/:id's own 404 for the same ticket", async () => {
    const app = makeApp(MAIN_PERSON);
    const listRes = await listTickets(app, workflowId);
    const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.map((t) => t.id)).not.toContain(aclBadLevelTicketId);

    const getRes = await app.request(`/tickets/${aclBadLevelTicketId}`);
    expect(getRes.status).toBe(404);
  });

  it("a workflow-admin acting person sees every ticket on the workflow, including ones with no personal relationship", async () => {
    const app = makeApp(WORKFLOW_ADMIN);
    const res = await listTickets(app, workflowId);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((t) => t.id);
    expect(ids).toContain(adminOnlyTicketId);
    expect(ids).toContain(unrelatedTicketId);
    expect(ids).toContain(creatorTicketId);
  });

  it("paginates correctly: two pages cover all rows with no duplicates or gaps, terminal nextCursor is null", async () => {
    const app = makeApp(PAGINATION_PERSON);
    const page1Res = await listTickets(app, paginationWorkflowId, "?limit=2");
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      data: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2Res = await listTickets(
      app,
      paginationWorkflowId,
      `?limit=2&cursor=${encodeURIComponent(page1.nextCursor as string)}`,
    );
    const page2 = (await page2Res.json()) as {
      data: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page2.data).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.data, ...page2.data].map((t) => t.id).sort();
    expect(allIds).toEqual([...paginationTicketIds].sort());
  });

  it("rejects a malformed cursor with 400, not a silent fallback to page 1 (matches GET /workflows's own query-param validation status)", async () => {
    const app = makeApp(PAGINATION_PERSON);
    const res = await listTickets(
      app,
      paginationWorkflowId,
      "?cursor=not-a-real-cursor!!!",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("rejects a limit over the maximum page size with 400", async () => {
    const app = makeApp(PAGINATION_PERSON);
    const res = await listTickets(app, paginationWorkflowId, "?limit=1000");
    expect(res.status).toBe(400);
  });

  it("redacts pii/financial fields identically to GET /tickets/:id", async () => {
    const sensitiveEntityType = await createEntityType(db, null, {
      name: `third_party_list_sensitive_test_${Date.now()}`,
      plural: "third_party_list_sensitive_tests",
      allowCustomFields: true,
    });
    await db.execute(
      sql`INSERT INTO entity_fields (entity_type_id, tenant_id, name, label, field_type, config, is_required, is_indexed, is_system, sort_order, sensitivity)
          VALUES (${sensitiveEntityType.id}::uuid, NULL, 'ssn', 'SSN', 'text', '{}'::jsonb, false, false, false, 0, 'pii')`,
    );
    const sensitiveWorkflow = await createWorkflow(db, TENANT, "test-actor", {
      entityTypeId: sensitiveEntityType.id,
      name: `third_party_list_sensitive_workflow_${Date.now()}`,
      initialState: "open",
    });
    await addWorkflowState(
      db,
      TENANT,
      sensitiveWorkflow.id,
      { userId: "test-actor", isGlobalAdmin: true },
      { name: "open", label: "Open", isTerminal: false, sortOrder: 0 },
    );
    await createEntity(db, TENANT, {
      entityTypeId: sensitiveEntityType.id,
      fields: { ssn: "123-45-6789" },
      createdBy: MAIN_PERSON,
      workflowId: sensitiveWorkflow.id,
      currentState: "open",
    });

    const app = makeApp(MAIN_PERSON);
    const res = await listTickets(app, sensitiveWorkflow.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ fields: Record<string, unknown> }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.fields.ssn).toBe("[REDACTED]");
  });

  it("returns 404 for a nonexistent workflow id", async () => {
    const app = makeApp(MAIN_PERSON);
    const res = await listTickets(app, "00000000-0000-4000-a000-000000000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({ error: "NOT_FOUND", message: "Record not found" });
  });

  it("returns the identical 404 for a workflow belonging to a different tenant", async () => {
    const app = makeApp(MAIN_PERSON);
    const res = await listTickets(app, otherTenantWorkflowId);
    expect(res.status).toBe(404);
  });

  it("rejects a key without the entity:ticket:read scope", async () => {
    const app = makeApp(MAIN_PERSON, ["entity:ticket:create"]);
    const res = await listTickets(app, workflowId);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("FORBIDDEN");
  });

  it("rejects a request whose auth userId does not start with apikey:", async () => {
    const app = new Hono<Vars>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        userId: "user-jwt-token-id-12345",
        tenantId: TENANT,
        roles: ["entity:ticket:read"],
        email: "",
        displayName: "User",
        orgId: "org-fff",
      });
      c.set("actingPerson", {
        userId: MAIN_PERSON,
        email: `${MAIN_PERSON}@example.com`,
        displayName: MAIN_PERSON,
        orgId: "org-fff",
      });
      await next();
    });
    app.get("/workflows/:workflowId/tickets", ...listThirdPartyTicketsHandler);
    const res = await listTickets(app, workflowId);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body.message).toBe("Invalid token");
  });

  it("sets the standard per-key-and-person rate-limit headers on a successful response", async () => {
    const app = makeApp(MAIN_PERSON);
    const res = await listTickets(app, workflowId);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-key-person-limit")).not.toBeNull();
    expect(res.headers.get("x-ratelimit-key-person-remaining")).not.toBeNull();
    expect(res.headers.get("x-ratelimit-key-person-reset")).not.toBeNull();
  });
});
