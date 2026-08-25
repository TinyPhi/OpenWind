/**
 * Isolation tests for POST /api/v1/tickets/:id/comments (ADR-012 Phase C,
 * PR C1, spec R1/R2/R3).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked). As in
 * third-party-ticket-detail.isolation.test.ts, `actingPerson` is set
 * directly via a stub middleware — the thing under test here is this
 * route's own access-list gating, always-404 behavior, and ingress
 * sanitization, not requireActingPerson's JWT verification (unit-tested
 * separately).
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
  workflowEvents,
  outboxEvents,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { createThirdPartyCommentHandler } from "../../src/routes/third-party/comments.js";

const TENANT = "eeeeeeee-0000-4000-e000-000000000604";
const OTHER_TENANT = "ffffffff-0000-4000-f000-000000000605";

let entityTypeId: string;
let workflowId: string;
let creatorTicketId: string;
let readOnlyTicketId: string;
let readCommentTicketId: string;
let noAccessTicketId: string;
let otherTenantTicketId: string;

const CREATOR = "third-party-comment-creator";
const READ_ONLY_PERSON = "third-party-comment-read-only";
const READ_COMMENT_PERSON = "third-party-comment-read-comment";
const NO_ACCESS_PERSON = "third-party-comment-no-access";

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
    { id: TENANT, name: "3P Comment Tenant", slug: `3p-comment-${TENANT}` },
    {
      id: OTHER_TENANT,
      name: "3P Comment Other Tenant",
      slug: `3p-comment-other-${OTHER_TENANT}`,
    },
  ]);

  const entityType = await createEntityType(db, null, {
    name: `third_party_comment_test_${Date.now()}`,
    plural: "third_party_comment_tests",
    allowCustomFields: true,
  });
  entityTypeId = entityType.id;

  const [workflow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "3P Comment Workflow",
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

  const readOnlyTicket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  readOnlyTicketId = readOnlyTicket.id;
  await grantAccess(readOnlyTicketId, READ_ONLY_PERSON, "read_only");

  const readCommentTicket = await createEntity(db, TENANT, {
    entityTypeId,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  readCommentTicketId = readCommentTicket.id;
  await grantAccess(readCommentTicketId, READ_COMMENT_PERSON, "read_comment");

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
          name: `third_party_comment_other_test_${Date.now()}`,
          plural: "third_party_comment_other_tests",
          allowCustomFields: true,
        })
      ).id,
      name: "3P Other Tenant Comment Workflow",
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
  app.post("/:id/comments", ...createThirdPartyCommentHandler);
  return app;
}

function apiKeyAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "apikey:33333333-3333-3333-3333-333333333333",
    tenantId: TENANT,
    roles: ["entity:ticket:comment"],
    email: "",
    displayName: "API Key 33333333",
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

async function postComment(app: Hono<Vars>, ticketId: string, text: string) {
  return app.request(`/${ticketId}/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

describe("POST /api/v1/tickets/:id/comments", () => {
  it("creator can comment on their own ticket", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await postComment(app, creatorTicketId, "hello from the API");
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    const [event] = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.id, data.id));
    expect(event?.metadata).toMatchObject({
      type: "comment",
      text: "hello from the API",
      actorType: "api_key",
      actingPersonId: CREATOR,
    });
  });

  it("writes a comment.created outbox event so WS live-push/automations still fire", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await postComment(
      app,
      creatorTicketId,
      "outbox regression check",
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    const [outboxRow] = await db
      .select()
      .from(outboxEvents)
      .where(
        sql`${outboxEvents.tenantId} = ${TENANT} AND ${outboxEvents.eventType} = 'comment.created' AND payload->>'commentId' = ${data.id}`,
      );
    expect(outboxRow).toBeDefined();
    expect(outboxRow?.payload).toMatchObject({
      eventType: "comment.created",
      instanceId: creatorTicketId,
      actorId: CREATOR,
      commentId: data.id,
    });
  });

  it("a person with only read_comment access can comment", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(READ_COMMENT_PERSON));
    const res = await postComment(app, readCommentTicketId, "commenting in");
    expect(res.status).toBe(201);
  });

  it("a person with only read_only access is rejected — this is the exact tier hasEntityCommentAccess exists to enforce", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(READ_ONLY_PERSON));
    const res = await postComment(app, readOnlyTicketId, "should not land");
    expect(res.status).toBe(404);
  });

  it("a person with no relation to the ticket gets 404, not 403", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(NO_ACCESS_PERSON));
    const res = await postComment(app, noAccessTicketId, "should not land");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("a genuinely nonexistent ticket ID produces the exact same response as an access-denied one", async () => {
    const denied = await postComment(
      makeApp(apiKeyAuth(), actingAs(NO_ACCESS_PERSON)),
      noAccessTicketId,
      "x",
    );
    const nonexistent = await postComment(
      makeApp(apiKeyAuth(), actingAs(CREATOR)),
      "00000000-0000-4000-a000-000000000000",
      "x",
    );
    expect(nonexistent.status).toBe(denied.status);
    expect(await nonexistent.json()).toEqual(await denied.json());
  });

  it("a ticket belonging to a different tenant produces the same 404 as an inaccessible same-tenant ticket", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await postComment(app, otherTenantTicketId, "x");
    expect(res.status).toBe(404);
  });

  it("rejects a key without the entity:ticket:comment scope", async () => {
    const app = makeApp(
      apiKeyAuth({ roles: ["entity:ticket:read"] }),
      actingAs(CREATOR),
    );
    const res = await postComment(app, creatorTicketId, "x");
    expect(res.status).toBe(403);
  });

  it("rejects comment text containing a null byte at ingress", async () => {
    const app = makeApp(apiKeyAuth(), actingAs(CREATOR));
    const res = await postComment(
      app,
      creatorTicketId,
      `bad${String.fromCharCode(0)}value`,
    );
    expect(res.status).toBe(400);
  });

  it("returns the same identical 404 when the workflow is deleted out from under the access check, not a distinguishable error", async () => {
    // A workflow-admin-only person (not creator/assignee/on any access list)
    // forces hasEntityCommentAccessFull down its getWorkflow path -- deleting
    // the workflow row before the request reproduces the exact race #184
    // documents (workflow deleted between the instance fetch and this
    // lookup), deterministically rather than via real concurrency.
    const WORKFLOW_ADMIN_PERSON = "third-party-comment-workflow-admin";
    const raceEntityType = await createEntityType(db, null, {
      name: `third_party_comment_race_test_${Date.now()}`,
      plural: "third_party_comment_race_tests",
      allowCustomFields: true,
    });
    const [raceWorkflow] = await db
      .insert(workflows)
      .values({
        tenantId: TENANT,
        entityTypeId: raceEntityType.id,
        name: "3P Comment Race Workflow",
        initialState: "open",
        assignedTo: [WORKFLOW_ADMIN_PERSON],
      })
      .returning({ id: workflows.id });
    const raceWorkflowId = raceWorkflow!.id;
    await db.insert(workflowStates).values({
      tenantId: TENANT,
      workflowId: raceWorkflowId,
      name: "open",
      label: "Open",
      sortOrder: 0,
    });
    const raceTicket = await createEntity(db, TENANT, {
      entityTypeId: raceEntityType.id,
      fields: {},
      createdBy: "someone-else",
      workflowId: raceWorkflowId,
      currentState: "open",
    });

    await db
      .delete(workflowEvents)
      .where(eq(workflowEvents.workflowId, raceWorkflowId));
    await db
      .delete(workflowStates)
      .where(eq(workflowStates.workflowId, raceWorkflowId));
    await db.delete(workflows).where(eq(workflows.id, raceWorkflowId));

    const app = makeApp(apiKeyAuth(), actingAs(WORKFLOW_ADMIN_PERSON));
    const res = await postComment(app, raceTicket.id, "should 404 cleanly");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({ error: "NOT_FOUND", message: "Record not found" });
  });
});
