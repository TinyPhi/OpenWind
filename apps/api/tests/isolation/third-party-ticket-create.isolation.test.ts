/**
 * Isolation tests for POST /api/v1/tickets (ADR-012 Phase B, PR B3,
 * spec R6/R8/R9/R11/R13/R14).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked). As in the
 * other third-party isolation suites, `actingPerson` is set directly via a
 * stub middleware — the thing under test here is this route's own
 * force-to-initial-state, scope, actor-identity, and payload-guard behavior.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { eq, and } from "drizzle-orm";
import {
  db,
  tenants,
  workflows,
  workflowStates,
  adminAuditLog,
  withTenantContext,
} from "@platform/db";
import {
  createEntityType,
  registerEntityAuditHook,
} from "@platform/entity-engine";
import { writeAuditEntry } from "@platform/audit";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { createThirdPartyTicketHandler } from "../../src/routes/third-party/tickets.js";

const TENANT = "12121212-0000-4000-a000-000000000506";

let entityTypeId: string;
let workflowId: string;
const createdInstanceIds: string[] = [];

beforeAll(async () => {
  // This test builds a bare Hono app directly from the route handler and
  // never imports apps/api/src/app.ts, so app.ts's own module-load-time
  // registerEntityAuditHook call never runs — mirror that exact wiring here
  // so the "records actor_type/acting_person_id" test below can observe a
  // real audit row from the real creation flow, not a hand-inserted one.
  registerEntityAuditHook(async (p) => {
    await writeAuditEntry(p.db, {
      tenantId: p.tenantId,
      actorId: p.actorId,
      actorType: p.actorType,
      actingPersonId: p.actingPersonId,
      resourceType: p.resourceType,
      resourceId: p.resourceId,
      action: p.action,
      beforeSnapshot: p.beforeSnapshot,
      afterSnapshot: p.afterSnapshot,
      entityFields: p.entityFields,
    });
  });

  await db.insert(tenants).values({
    id: TENANT,
    name: "3P Ticket Create Tenant",
    slug: `3p-ticket-create-${TENANT}`,
  });

  const entityType = await createEntityType(db, null, {
    name: `third_party_ticket_create_test_${Date.now()}`,
    plural: "third_party_ticket_create_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "3P Ticket Create Workflow",
      initialState: "open",
    })
    .returning({ id: workflows.id });
  workflowId = workflow!.id;

  await db.insert(workflowStates).values([
    { tenantId: TENANT, workflowId, name: "open", label: "Open", sortOrder: 0 },
    {
      tenantId: TENANT,
      workflowId,
      name: "closed",
      label: "Closed",
      isTerminal: true,
      sortOrder: 1,
    },
  ]);
});

afterAll(async () => {
  // admin_audit_log is append-only by design — app_user has no DELETE grant
  // on it (see @platform/audit's own module doc), so cleanup must go
  // through the bare/superuser db connection, same as
  // audit-log.isolation.test.ts's own teardown.
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
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
  app.post("/", ...createThirdPartyTicketHandler);
  return app;
}

function apiKeyAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "apikey:33333333-3333-3333-3333-333333333333",
    tenantId: TENANT,
    roles: ["entity:ticket:create"],
    email: "",
    displayName: "API Key 33333333",
    orgId: "org-121",
    ...overrides,
  };
}

const ACTING_PERSON: ActingPersonContext = {
  userId: "third-party-ticket-creator",
  email: "creator@example.com",
  displayName: "Third Party Creator",
  orgId: "org-121",
};

describe("POST /api/v1/tickets", () => {
  it("creates a ticket into the workflow's initial state, ignoring any state field sent", async () => {
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId,
        fields: { title: "Test ticket" },
        state: "closed",
        currentState: "closed",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; currentState: string; createdBy: string };
    };
    createdInstanceIds.push(body.data.id);
    expect(body.data.currentState).toBe("open");
    expect(body.data.createdBy).toBe(ACTING_PERSON.userId);
  });

  it("applies an optional assignee", async () => {
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId,
        fields: {},
        assignedTo: "some-assignee",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; assignedTo: string };
    };
    createdInstanceIds.push(body.data.id);
    expect(body.data.assignedTo).toBe("some-assignee");
  });

  it("records actor_type=api_key plus a populated acting_person_id distinct from actor_id", async () => {
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, fields: {} }),
    });
    const body = (await res.json()) as { data: { id: string } };
    createdInstanceIds.push(body.data.id);

    const [entry] = await withTenantContext(TENANT, (tx) =>
      tx
        .select({
          actorType: adminAuditLog.actorType,
          actorId: adminAuditLog.actorId,
          actingPersonId: adminAuditLog.actingPersonId,
        })
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.resourceId, body.data.id),
            eq(adminAuditLog.action, "created"),
          ),
        )
        .limit(1),
    );

    expect(entry?.actorType).toBe("api_key");
    expect(entry?.actingPersonId).toBe(ACTING_PERSON.userId);
    // Bug: createEntity's audit hook used to stamp actor_id with createdBy
    // (the acting person) instead of the key's own application-actor id,
    // even though actorType was correctly "api_key" — admin/third-party-
    // access-logs.ts then failed trying to look up that non-uuid person id
    // as an api_keys.id. actor_id must be the key, distinct from both
    // actor_type and acting_person_id above.
    expect(entry?.actorId).toBe("33333333-3333-3333-3333-333333333333");
    expect(entry?.actorId).not.toBe(ACTING_PERSON.userId);
  });

  it("rejects a key without the entity:ticket:create scope", async () => {
    const app = makeApp(
      apiKeyAuth({ roles: ["entity:ticket:read"] }),
      ACTING_PERSON,
    );
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, fields: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a fields payload containing a null byte", async () => {
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId,
        fields: { title: `bad${String.fromCharCode(0)}value` },
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("VALIDATION_ERROR");
  });

  it("rejects a fields payload exceeding the size guard", async () => {
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId,
        fields: { blob: "x".repeat(200_000) },
      }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects a fields payload nested deeper than the depth guard", async () => {
    let deeplyNested: unknown = "leaf";
    for (let i = 0; i < 12; i++) {
      deeplyNested = { nested: deeplyNested };
    }
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, fields: { deep: deeplyNested } }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 404 for a workflowId that doesn't belong to this tenant", async () => {
    const app = makeApp(apiKeyAuth(), ACTING_PERSON);
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workflowId: "00000000-0000-4000-a000-000000000000",
        fields: {},
      }),
    });
    expect(res.status).toBe(404);
  });
});
