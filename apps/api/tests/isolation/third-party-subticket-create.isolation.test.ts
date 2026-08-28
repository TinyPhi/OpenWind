/**
 * Isolation tests for POST /api/v1/tickets/:id/children (ADR-012 Phase C,
 * PR C3, spec R9).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked). Covers:
 * access-list gating on the parent, ACL-inheritance from parent to child
 * (the bug fix in createChildRelation), and the 1-level API nesting cap.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq, sql } from "drizzle-orm";
import {
  db,
  tenants,
  workflows,
  workflowStates,
  entityInstances,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { createThirdPartyChildHandler } from "../../src/routes/third-party/children.js";

const TENANT = "eeeeeeee-0000-4000-e000-000000000704";
const OTHER_TENANT = "ffffffff-0000-4000-f000-000000000705";

let entityTypeId: string;
let workflowId: string;
let creatorTicketId: string;
let mentionedTicketId: string;
let noAccessTicketId: string;
let otherTenantTicketId: string;
let grandchildParentId: string;
let softDeletedTicketId: string;

const CREATOR = "third-party-child-creator";
const MENTIONED_PERSON = "third-party-child-mentioned";
const NO_ACCESS_PERSON = "third-party-child-no-access";

async function grantAccess(
  ticketId: string,
  userId: string,
  level: "read_only" | "read_comment" | "read_write",
) {
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
    .where(eq(entityInstances.id, ticketId));
}

beforeAll(async () => {
  await db.insert(tenants).values([
    { id: TENANT, name: "3P Child Tenant", slug: `3p-child-${TENANT}` },
    {
      id: OTHER_TENANT,
      name: "3P Child Other Tenant",
      slug: `3p-child-other-${OTHER_TENANT}`,
    },
  ]);

  const entityType = await createEntityType(db, null, {
    name: `third_party_child_test_${Date.now()}`,
    plural: "third_party_child_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "3P Child Workflow",
      initialState: "open",
      maxChildDepth: 5,
      maxChildrenPerParent: 10,
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
  await grantAccess(creatorTicketId, MENTIONED_PERSON, "read_comment");
  mentionedTicketId = creatorTicketId;

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
          name: `third_party_child_other_test_${Date.now()}`,
          plural: "third_party_child_other_tests",
          allowCustomFields: true,
        })
      ).id,
      name: "3P Other Tenant Child Workflow",
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

  // A ticket that will have a sub-ticket created under it during the test
  // run, then used as the (already-a-child) target for the nesting-cap test.
  const grandchildParentTicket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  grandchildParentId = grandchildParentTicket.id;

  const softDeletedTicket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  softDeletedTicketId = softDeletedTicket.id;
  await db
    .update(entityInstances)
    .set({ deletedAt: new Date() })
    .where(eq(entityInstances.id, softDeletedTicketId));
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
  app.post("/:id/children", ...createThirdPartyChildHandler);
  return app;
}

function apiKeyAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "apikey:44444444-4444-4444-4444-444444444444",
    tenantId: TENANT,
    roles: ["entity:ticket:subticket"],
    email: "",
    displayName: "API Key 44444444",
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

async function postChild(
  app: Hono<Vars>,
  parentId: string,
  fields: object = {},
) {
  return app.request(`/${parentId}/children`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entityTypeId, fields }),
  });
}

describe("POST /api/v1/tickets/:id/children", () => {
  it("creator can create a sub-ticket under their own ticket", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await postChild(app, creatorTicketId, { title: "sub" });
    expect(res.status).toBe(201);
  });

  it("child inherits the parent's __accessUsers grants — the ACL-inheritance bug fix", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await postChild(app, mentionedTicketId, { title: "sub2" });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as {
      data: { fields: { __accessUsers?: Record<string, { level: string }> } };
    };
    expect(data.fields.__accessUsers?.[MENTIONED_PERSON]?.level).toBe(
      "read_comment",
    );
  });

  it("a person with only mention-grant access on the parent can create a sub-ticket (hasEntityAccess, any level)", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(MENTIONED_PERSON));
    const res = await postChild(app, mentionedTicketId, { title: "sub3" });
    expect(res.status).toBe(201);
  });

  it("a person with no relation to the parent gets 404, not 403", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(NO_ACCESS_PERSON));
    const res = await postChild(app, noAccessTicketId, { title: "x" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("a parent belonging to a different tenant produces the same 404", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await postChild(app, otherTenantTicketId, { title: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects a key without the entity:ticket:subticket scope", async () => {
    const app = makeApp(
      apiKeyAuth({ roles: ["entity:ticket:read"] }),
      actingAs(CREATOR),
    );
    const res = await postChild(app, creatorTicketId, { title: "x" });
    expect(res.status).toBe(403);
  });

  it("a soft-deleted parent produces the same 404 as a nonexistent one, not a different error", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await postChild(app, softDeletedTicketId, { title: "x" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({ error: "NOT_FOUND", message: "Record not found" });
  });

  it("rejects creating a sub-ticket under an already-API-created sub-ticket (1-level nesting cap)", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const firstChild = await postChild(app, grandchildParentId, {
      title: "level-1 child",
    });
    expect(firstChild.status).toBe(201);
    const { data } = (await firstChild.json()) as { data: { id: string } };

    const secondLevel = await postChild(app, data.id, {
      title: "level-2 child — should be rejected",
    });
    expect(secondLevel.status).toBe(400);
    const body = (await secondLevel.json()) as { error: string };
    expect(body.error).toBe("SUBTICKET_NESTING_EXCEEDED");
  });
});
