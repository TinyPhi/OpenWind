/**
 * Isolation tests for GET /api/v1/tickets/:id (ADR-012 Phase B, PR B4,
 * spec R7/R8).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked). As in
 * third-party-workflows-list.isolation.test.ts, `actingPerson` is set
 * directly via a stub middleware (requireActingPerson's real Zitadel JWT
 * verification is unit-tested separately) — the thing under test here is
 * this route's own access-list gating and always-404 behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray } from "drizzle-orm";
import { db, tenants, workflows, workflowStates } from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { getThirdPartyTicketHandler } from "../../src/routes/third-party/tickets.js";

const TENANT = "eeeeeeee-0000-4000-e000-000000000504";
const OTHER_TENANT = "ffffffff-0000-4000-f000-000000000505";

let entityTypeId: string;
let workflowId: string;
let creatorTicketId: string;
let assigneeTicketId: string;
let noAccessTicketId: string;
let otherTenantTicketId: string;

const CREATOR = "third-party-creator";
const ASSIGNEE = "third-party-assignee";
const NO_ACCESS_PERSON = "third-party-no-access";

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT,
      name: "3P Ticket Detail Tenant",
      slug: `3p-ticket-${TENANT}`,
    },
    {
      id: OTHER_TENANT,
      name: "3P Ticket Detail Other Tenant",
      slug: `3p-ticket-other-${OTHER_TENANT}`,
    },
  ]);

  const entityType = await createEntityType(db, null, {
    name: `third_party_ticket_test_${Date.now()}`,
    plural: "third_party_ticket_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "3P Ticket Detail Workflow",
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

  const creatorTicket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  creatorTicketId = creatorTicket.id;

  const assigneeTicket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: "someone-else",
    assignedTo: ASSIGNEE,
    workflowId,
    currentState: "open",
  });
  assigneeTicketId = assigneeTicket.id;

  const noAccessTicket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  noAccessTicketId = noAccessTicket.id;

  const [otherWorkflow] = await db
    .insert(workflows)
    .values({
      tenantId: OTHER_TENANT,
      entityTypeId: (
        await createEntityType(db, null, {
          name: `third_party_ticket_other_test_${Date.now()}`,
          plural: "third_party_ticket_other_tests",
          allowCustomFields: true,
        })
      ).id,
      name: "3P Other Tenant Ticket Workflow",
      initialState: "open",
    })
    .returning({ id: workflows.id, entityTypeId: workflows.entityTypeId });
  await db.insert(workflowStates).values({
    tenantId: OTHER_TENANT,
    workflowId: otherWorkflow!.id,
    name: "open",
    label: "Open",
    sortOrder: 0,
  });
  const otherTicket = await createEntity(db, OTHER_TENANT, {
    entityTypeId: otherWorkflow!.entityTypeId,
    fields: {},
    createdBy: CREATOR,
    workflowId: otherWorkflow!.id,
    currentState: "open",
  });
  otherTenantTicketId = otherTicket.id;
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT, OTHER_TENANT]));
});

type Vars = {
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
};

function makeApp(auth: AuthContext, actingPerson: ActingPersonContext) {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", auth);
    c.set("actingPerson", actingPerson);
    await next();
  });
  app.get("/:id", ...getThirdPartyTicketHandler);
  return app;
}

function apiKeyAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "apikey:22222222-2222-2222-2222-222222222222",
    tenantId: TENANT,
    roles: ["entity:ticket:read"],
    email: "",
    displayName: "API Key 22222222",
    orgId: "org-eee",
    ...overrides,
  };
}

function actingAs(userId: string): ActingPersonContext {
  return {
    userId,
    email: `${userId}@example.com`,
    displayName: userId,
    orgId: "org-eee",
  };
}

describe("GET /api/v1/tickets/:id", () => {
  it("creator can fetch their own ticket", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await app.request(`/${creatorTicketId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(creatorTicketId);
  });

  it("assignee can fetch a ticket they're assigned to", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(ASSIGNEE));
    const res = await app.request(`/${assigneeTicketId}`);
    expect(res.status).toBe(200);
  });

  it("a person with no relation to the ticket gets 404, not 403", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(NO_ACCESS_PERSON));
    const res = await app.request(`/${noAccessTicketId}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("a genuinely nonexistent ticket ID produces the exact same response as an access-denied one", async () => {
    const denied = await makeApp(
      apiKeyAuth(),
      actingAs(NO_ACCESS_PERSON),
    ).request(`/${noAccessTicketId}`);
    const nonexistent = await makeApp(apiKeyAuth(), actingAs(CREATOR)).request(
      "/00000000-0000-4000-a000-000000000000",
    );
    expect(nonexistent.status).toBe(denied.status);
    expect(await nonexistent.json()).toEqual(await denied.json());
  });

  it("a ticket belonging to a different tenant produces the same 404 as an inaccessible same-tenant ticket, via RLS/explicit-filter alone", async () => {
    // The key presented is for TENANT; otherTenantTicketId belongs to
    // OTHER_TENANT — getEntity's explicit tenant_id filter (plus RLS) makes
    // the row simply not exist from this key's point of view, no distinct
    // cross-tenant code path.
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await app.request(`/${otherTenantTicketId}`);
    expect(res.status).toBe(404);
  });

  it("rejects a key without the entity:ticket:read scope", async () => {
    const app = makeApp(
      apiKeyAuth({ roles: ["entity:ticket:create"] }),
      actingAs(CREATOR),
    );
    const res = await app.request(`/${creatorTicketId}`);
    expect(res.status).toBe(403);
  });
});
