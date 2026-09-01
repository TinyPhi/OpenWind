/**
 * Isolation tests for POST /api/v1/tickets/:id/transitions (ADR-012 Phase E,
 * spec R1/R2/R5).
 *
 * Real Postgres connection, RLS + app_user enforced (not mocked). Phase 1
 * scope per the task plan (T4a): the single most safety-critical case —
 * a granted-but-not-owner identity, even at read_write tier, must be
 * rejected on every transition attempt — plus the baseline success/failure
 * cases from R1/R5. R3/R4's audit/automation/outbox assertions and the
 * workflow-deleted-mid-request race test are T4b, phase 2.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq, sql, and } from "drizzle-orm";
import {
  db,
  tenants,
  entityInstances,
  outboxEvents,
  workflowEvents,
  workflowStates,
  workflows,
  adminAuditLog,
} from "@platform/db";
import { createEntityType, createEntity } from "@platform/entity-engine";
import {
  createWorkflow,
  addWorkflowState,
  addWorkflowTransition,
} from "@platform/workflow-engine";
import type { EntityType } from "@platform/entity-engine";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { executeThirdPartyTransitionHandler } from "../../src/routes/third-party/transitions.js";

const TENANT = "ffffffff-0000-4000-f000-000000000e01";
const OTHER_TENANT = "ffffffff-0000-4000-f000-000000000e02";

let entityType: EntityType;
let workflowId: string;
let openToProcessingId: string;
let openToInReviewId: string;
let openToProcessingUserRoleId: string;
let openToProcessingAdminOnlyId: string;
let userRoleTicketId: string;
let assigneeUserRoleTicketId: string;
let workflowAdminUserRoleTicketId: string;
let adminOnlyRoleTicketId: string;
let creatorTicketId: string;
let assigneeTicketId: string;
let adminOnlyTicketId: string;
let grantedTicketId: string;
let slaTestTicketId: string;
let otherTenantTicketId: string;
let invalidTransitionTicketId: string;

const CREATOR = "third-party-transition-creator";
const ASSIGNEE = "third-party-transition-assignee";
const WORKFLOW_ADMIN = "third-party-transition-workflow-admin";
const GRANTED_READ_WRITE_PERSON = "third-party-transition-granted-rw";
const NO_ACCESS_PERSON = "third-party-transition-no-access";

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
    .where(
      and(
        eq(entityInstances.id, ticketId),
        eq(entityInstances.tenantId, TENANT),
      ),
    );
}

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT,
      name: "3P Transition Tenant",
      slug: `3p-transition-${TENANT}`,
    },
    {
      id: OTHER_TENANT,
      name: "3P Transition Other Tenant",
      slug: `3p-transition-other-${OTHER_TENANT}`,
    },
  ]);

  entityType = await createEntityType(db, null, {
    name: `third_party_transition_test_${Date.now()}`,
    plural: "third_party_transition_tests",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `third_party_transition_workflow_${Date.now()}`,
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
  // slaHours set so a transition into this state exercises the engine's own
  // workflow.sla_scheduled outbox write (spec R4) — proves nothing about
  // that path is short-circuited for an API-driven transition.
  await addWorkflowState(db, TENANT, workflowId, caller, {
    name: "in_review",
    label: "In Review",
    isTerminal: false,
    sortOrder: 2,
    slaHours: 4,
  });

  const openToProcessing = await addWorkflowTransition(
    db,
    TENANT,
    workflowId,
    caller,
    { fromState: "open", toState: "processing" },
  );
  openToProcessingId = openToProcessing.id;

  const openToInReview = await addWorkflowTransition(
    db,
    TENANT,
    workflowId,
    caller,
    { fromState: "open", toState: "in_review" },
  );
  openToInReviewId = openToInReview.id;

  // Role-mapping fixtures (docs/specs/third-party-transition-role-mapping.md):
  // every real seeded workflow restricts allowed_roles, so these two prove
  // the third-party caller is granted the baseline "user" role (but never
  // "admin"/"agent") once hasTransitionAccess has already passed. Distinct
  // toState values (rather than both targeting "processing") so this fixture
  // doesn't create two transitions sharing the same (fromState, toState)
  // pair on one workflow -- semantically unusual and untested by the engine
  // today, but avoided here rather than relied upon (review F-04).
  const openToProcessingUserRole = await addWorkflowTransition(
    db,
    TENANT,
    workflowId,
    caller,
    {
      fromState: "open",
      toState: "processing_user_role",
      allowedRoles: ["admin", "agent", "user"],
    },
  );
  openToProcessingUserRoleId = openToProcessingUserRole.id;

  const openToProcessingAdminOnly = await addWorkflowTransition(
    db,
    TENANT,
    workflowId,
    caller,
    {
      fromState: "open",
      toState: "processing_admin_only",
      allowedRoles: ["admin"],
    },
  );
  openToProcessingAdminOnlyId = openToProcessingAdminOnly.id;

  const creatorTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  creatorTicketId = creatorTicket.id;

  const assigneeTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    assignedTo: ASSIGNEE,
    workflowId,
    currentState: "open",
  });
  assigneeTicketId = assigneeTicket.id;

  // WORKFLOW_ADMIN is on the workflow's own assignedTo list (workflow-admin
  // status), but has no personal relation to this specific ticket at all —
  // proves isWorkflowAdmin grants access without needing createdBy/assignedTo.
  await db.execute(
    sql`UPDATE workflows SET assigned_to = array_append(assigned_to, ${WORKFLOW_ADMIN}) WHERE id = ${workflowId}::uuid`,
  );
  const adminOnlyTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  adminOnlyTicketId = adminOnlyTicket.id;

  const grantedTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  grantedTicketId = grantedTicket.id;
  await grantAccess(grantedTicketId, GRANTED_READ_WRITE_PERSON, "read_write");

  const slaTestTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  slaTestTicketId = slaTestTicket.id;

  const userRoleTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  userRoleTicketId = userRoleTicket.id;

  const adminOnlyRoleTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: CREATOR,
    workflowId,
    currentState: "open",
  });
  adminOnlyRoleTicketId = adminOnlyRoleTicket.id;

  // F-01 (PR #514 review): the role-mapping fixtures above were only
  // exercised via the creator path -- these two prove the identical
  // actorRoles: ["user"] behavior for the other two hasTransitionAccess
  // paths (assignee, workflow-admin), matching the spec's §R claim that all
  // three access types are covered, not just one.
  const assigneeUserRoleTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    assignedTo: ASSIGNEE,
    workflowId,
    currentState: "open",
  });
  assigneeUserRoleTicketId = assigneeUserRoleTicket.id;

  const workflowAdminUserRoleTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    workflowId,
    currentState: "open",
  });
  workflowAdminUserRoleTicketId = workflowAdminUserRoleTicket.id;

  const invalidTransitionTicket = await createEntity(db, TENANT, {
    entityTypeId: entityType.id,
    fields: {},
    createdBy: "someone-else",
    assignedTo: ASSIGNEE,
    workflowId,
    currentState: "processing",
  });
  invalidTransitionTicketId = invalidTransitionTicket.id;

  const otherEntityType = await createEntityType(db, null, {
    name: `third_party_transition_other_test_${Date.now()}`,
    plural: "third_party_transition_other_tests",
    allowCustomFields: true,
  });
  const otherWorkflow = await createWorkflow(db, OTHER_TENANT, "test-actor", {
    entityTypeId: otherEntityType.id,
    name: `third_party_transition_other_workflow_${Date.now()}`,
    initialState: "open",
  });
  await addWorkflowState(
    db,
    OTHER_TENANT,
    otherWorkflow.id,
    { userId: "test-actor", isGlobalAdmin: true },
    { name: "open", label: "Open", isTerminal: false, sortOrder: 0 },
  );
  const otherTicket = await createEntity(db, OTHER_TENANT, {
    entityTypeId: otherEntityType.id,
    fields: {},
    createdBy: CREATOR,
    workflowId: otherWorkflow.id,
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

function makeApp(actingPersonId: string, tenantId: string = TENANT) {
  const app = new Hono<Vars>();
  app.use("*", async (c: Context<Vars>, next: Next) => {
    c.set("auth", {
      userId: "apikey:66666666-6666-4666-6666-666666666666",
      tenantId,
      roles: ["entity:ticket:transition"],
      email: "",
      displayName: "API Key 66666666",
      orgId: "org-hhh",
    });
    c.set("actingPerson", {
      userId: actingPersonId,
      email: `${actingPersonId}@example.com`,
      displayName: actingPersonId,
      orgId: "org-hhh",
    });
    await next();
  });
  app.post("/tickets/:id/transitions", ...executeThirdPartyTransitionHandler);
  return app;
}

async function postTransition(
  app: Hono<Vars>,
  ticketId: string,
  transitionId: string = openToProcessingId,
  comment?: string,
) {
  return app.request(`/tickets/${ticketId}/transitions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transitionId,
      ...(comment !== undefined && { comment }),
    }),
  });
}

describe("POST /api/v1/tickets/:id/transitions", () => {
  it("creator can execute a valid next-state transition", async () => {
    const app = makeApp(CREATOR);
    const res = await postTransition(app, creatorTicketId);
    expect(res.status).toBe(201);
  });

  it("assignee can execute a valid next-state transition", async () => {
    const app = makeApp(ASSIGNEE);
    const res = await postTransition(app, assigneeTicketId);
    expect(res.status).toBe(201);
  });

  it("workflow-admin (no personal createdBy/assignedTo relation) can execute a valid transition", async () => {
    const app = makeApp(WORKFLOW_ADMIN);
    const res = await postTransition(app, adminOnlyTicketId);
    expect(res.status).toBe(201);
  });

  it("creator can execute a transition whose allowed_roles includes 'user' — the third-party caller is granted the baseline 'user' role once ticket-level access already passed (docs/specs/third-party-transition-role-mapping.md R1)", async () => {
    const app = makeApp(CREATOR);
    const res = await postTransition(
      app,
      userRoleTicketId,
      openToProcessingUserRoleId,
    );
    expect(res.status).toBe(201);
  });

  it("assignee can execute a transition whose allowed_roles includes 'user' (review F-01)", async () => {
    const app = makeApp(ASSIGNEE);
    const res = await postTransition(
      app,
      assigneeUserRoleTicketId,
      openToProcessingUserRoleId,
    );
    expect(res.status).toBe(201);
  });

  it("workflow-admin (no personal createdBy/assignedTo relation) can execute a transition whose allowed_roles includes 'user' (review F-01)", async () => {
    const app = makeApp(WORKFLOW_ADMIN);
    const res = await postTransition(
      app,
      workflowAdminUserRoleTicketId,
      openToProcessingUserRoleId,
    );
    expect(res.status).toBe(201);
  });

  it("still 403s a transition whose allowed_roles is {'admin'} only — the baseline-'user' mapping never grants elevated roles (R1)", async () => {
    const app = makeApp(CREATOR);
    const res = await postTransition(
      app,
      adminOnlyRoleTicketId,
      openToProcessingAdminOnlyId,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("TRANSITION_FORBIDDEN");
  });

  it("rejects a person with only a read_write __accessUsers grant, even though comment/read access would allow it — the critical boundary this phase exists to enforce (spec R2)", async () => {
    const app = makeApp(GRANTED_READ_WRITE_PERSON);
    const res = await postTransition(app, grantedTicketId);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({ error: "NOT_FOUND", message: "Record not found" });
  });

  it("a person with no relation at all gets the identical 404, not 403", async () => {
    const app = makeApp(NO_ACCESS_PERSON);
    const res = await postTransition(app, creatorTicketId);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("a ticket belonging to a different tenant produces the identical 404 as an inaccessible same-tenant ticket", async () => {
    const app = makeApp(CREATOR);
    const res = await postTransition(app, otherTenantTicketId);
    expect(res.status).toBe(404);
  });

  it("a nonexistent ticket id produces the identical 404 body as a granted-but-not-owner denial (spec R5)", async () => {
    const denied = await postTransition(
      makeApp(GRANTED_READ_WRITE_PERSON),
      grantedTicketId,
    );
    const nonexistent = await postTransition(
      makeApp(CREATOR),
      "00000000-0000-4000-a000-000000000000",
    );
    expect(nonexistent.status).toBe(denied.status);
    expect(await nonexistent.json()).toEqual(await denied.json());
  });

  it("rejects a key without the entity:ticket:transition scope", async () => {
    const app = new Hono<Vars>();
    app.use("*", async (c: Context<Vars>, next: Next) => {
      c.set("auth", {
        userId: "apikey:66666666-6666-4666-6666-666666666666",
        tenantId: TENANT,
        roles: ["entity:ticket:read"],
        email: "",
        displayName: "API Key 66666666",
        orgId: "org-hhh",
      });
      c.set("actingPerson", {
        userId: CREATOR,
        email: `${CREATOR}@example.com`,
        displayName: CREATOR,
        orgId: "org-hhh",
      });
      await next();
    });
    app.post("/tickets/:id/transitions", ...executeThirdPartyTransitionHandler);
    const res = await postTransition(app, creatorTicketId);
    expect(res.status).toBe(403);
  });

  it("rejects a transition not valid from the ticket's current state with the identical error a human caller would get (spec R1)", async () => {
    // processingToDoneId doesn't exist -- reuse openToProcessingId against a
    // ticket already in "processing" (invalidTransitionTicketId, seeded in beforeAll):
    // fromState mismatch triggers the engine's own TRANSITION_NOT_AVAILABLE.
    const app = makeApp(ASSIGNEE);
    const res = await postTransition(
      app,
      invalidTransitionTicketId,
      openToProcessingId,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("TRANSITION_NOT_AVAILABLE");
  });

  it("writes exactly one workflow.transitioned outbox row per successful transition, and schedules its SLA outbox event identically to a human-triggered transition (spec R4)", async () => {
    const app = makeApp(CREATOR);
    const res = await postTransition(app, slaTestTicketId, openToInReviewId);
    expect(res.status).toBe(201);

    const transitionedRows = await db
      .select()
      .from(outboxEvents)
      .where(
        sql`${outboxEvents.tenantId} = ${TENANT} AND ${outboxEvents.eventType} = 'workflow.transitioned' AND payload->>'instanceId' = ${slaTestTicketId}`,
      );
    expect(transitionedRows).toHaveLength(1);

    const slaRows = await db
      .select()
      .from(outboxEvents)
      .where(
        sql`${outboxEvents.tenantId} = ${TENANT} AND ${outboxEvents.eventType} = 'workflow.sla_scheduled' AND payload->>'instanceId' = ${slaTestTicketId}`,
      );
    expect(slaRows).toHaveLength(1);
  });

  it("logs both allowed and denied attempts to admin_audit_log with app+person attribution (spec R3)", async () => {
    // 1. Create dedicated tickets specifically for this audit log test to avoid cross-test dependencies
    const auditAllowedTicket = await createEntity(db, TENANT, {
      entityTypeId: entityType.id,
      fields: {},
      createdBy: CREATOR,
      workflowId,
      currentState: "open",
    });

    const auditDeniedTicket = await createEntity(db, TENANT, {
      entityTypeId: entityType.id,
      fields: {},
      createdBy: "someone-else",
      workflowId,
      currentState: "open",
    });
    await grantAccess(
      auditDeniedTicket.id,
      GRANTED_READ_WRITE_PERSON,
      "read_write",
    );

    // 2. Trigger transitions to generate the audit log rows
    const allowedApp = makeApp(CREATOR);
    await postTransition(allowedApp, auditAllowedTicket.id, openToProcessingId);

    const deniedApp = makeApp(GRANTED_READ_WRITE_PERSON);
    await postTransition(deniedApp, auditDeniedTicket.id, openToProcessingId);

    // 3. Assert the audit log rows
    const allowedRows = await db
      .select()
      .from(adminAuditLog)
      .where(
        sql`${adminAuditLog.tenantId} = ${TENANT} AND ${adminAuditLog.action} = 'transition.executed' AND ${adminAuditLog.resourceId} = ${auditAllowedTicket.id}`,
      );
    expect(allowedRows.length).toBe(1);
    expect(allowedRows[0]?.actorType).toBe("api_key");
    expect(allowedRows[0]?.actingPersonId).toBe(CREATOR);
    // spec AC6 -- actorId is the API key's own id (parsed from auth.userId's
    // "apikey:<id>" prefix), NOT actingPersonId, so Phase F's admin route can
    // resolve applicationName from it.
    expect(allowedRows[0]?.actorId).toBe(
      "66666666-6666-4666-6666-666666666666",
    );

    const deniedRows = await db
      .select()
      .from(adminAuditLog)
      .where(
        sql`${adminAuditLog.tenantId} = ${TENANT} AND ${adminAuditLog.action} = 'transition.access_denied' AND ${adminAuditLog.resourceId} = ${auditDeniedTicket.id}`,
      );
    expect(deniedRows.length).toBe(1);
    expect(deniedRows[0]?.actingPersonId).toBe(GRANTED_READ_WRITE_PERSON);
  });

  it("returns the same identical 404 when the workflow is deleted out from under the access check, not a distinguishable error", async () => {
    // A workflow-admin-only person (not creator/assignee/on any access list)
    // forces hasTransitionAccess down its getWorkflow path -- deleting the
    // workflow row before the request reproduces the exact race (#184,
    // already closed on the comment-post and attachment routes)
    // deterministically rather than via real concurrency.
    const RACE_ADMIN = "third-party-transition-race-admin";
    const raceEntityType = await createEntityType(db, null, {
      name: `third_party_transition_race_test_${Date.now()}`,
      plural: "third_party_transition_race_tests",
      allowCustomFields: true,
    });
    const raceWorkflow = await createWorkflow(db, TENANT, "test-actor", {
      entityTypeId: raceEntityType.id,
      name: `third_party_transition_race_workflow_${Date.now()}`,
      initialState: "open",
    });
    await addWorkflowState(
      db,
      TENANT,
      raceWorkflow.id,
      { userId: "test-actor", isGlobalAdmin: true },
      { name: "open", label: "Open", isTerminal: false, sortOrder: 0 },
    );
    await db.execute(
      sql`UPDATE workflows SET assigned_to = array_append(assigned_to, ${RACE_ADMIN}) WHERE id = ${raceWorkflow.id}::uuid`,
    );
    const raceTicket = await createEntity(db, TENANT, {
      entityTypeId: raceEntityType.id,
      fields: {},
      createdBy: "someone-else",
      workflowId: raceWorkflow.id,
      currentState: "open",
    });

    await db
      .delete(workflowEvents)
      .where(eq(workflowEvents.workflowId, raceWorkflow.id));
    await db
      .delete(workflowStates)
      .where(eq(workflowStates.workflowId, raceWorkflow.id));
    await db.delete(workflows).where(eq(workflows.id, raceWorkflow.id));

    const app = makeApp(RACE_ADMIN);
    const res = await postTransition(app, raceTicket.id, openToProcessingId);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({ error: "NOT_FOUND", message: "Record not found" });
  });

  it("returns 409 with Retry-After when the ticket is locked by another transaction (F-02)", async () => {
    const app = makeApp(CREATOR);
    try {
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(entityInstances)
          .where(eq(entityInstances.id, creatorTicketId))
          .for("update", { noWait: true });

        const res = await postTransition(app, creatorTicketId);
        expect(res.status).toBe(409);
        expect(res.headers.get("retry-after")).toBe("5");
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe("TRANSITION_LOCKED");
        expect(body.message).toContain("Another transition is in progress");

        throw new Error("ROLLBACK");
      });
    } catch (err) {
      if (err instanceof Error && err.message === "ROLLBACK") {
        // expected rollback
      } else {
        throw err;
      }
    }
  });

  it("rejects invalid comments containing control chars or being empty (F-04)", async () => {
    const app = makeApp(CREATOR);
    const commentTicket = await createEntity(db, TENANT, {
      entityTypeId: entityType.id,
      fields: {},
      createdBy: CREATOR,
      workflowId,
      currentState: "open",
    });

    // 1. Reject empty-string comment
    const resEmpty = await postTransition(
      app,
      commentTicket.id,
      openToProcessingId,
      "",
    );
    expect(resEmpty.status).toBe(400);

    // 2. Reject comment with null byte / control character
    const resCtrl = await postTransition(
      app,
      commentTicket.id,
      openToProcessingId,
      "invalid comment\x00",
    );
    expect(resCtrl.status).toBe(400);

    // 3. Accept valid comment
    const resValid = await postTransition(
      app,
      commentTicket.id,
      openToProcessingId,
      "Valid comment",
    );
    expect(resValid.status).toBe(201);
  });

  it("rejects request if userId does not start with apikey: prefix (#496)", async () => {
    const app = new Hono<Vars>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        userId: "user-jwt-token-id-12345",
        tenantId: TENANT,
        roles: ["entity:ticket:transition"],
        email: "",
        displayName: "User",
        orgId: "org-hhh",
      });
      c.set("actingPerson", {
        userId: CREATOR,
        email: `${CREATOR}@example.com`,
        displayName: CREATOR,
        orgId: "org-hhh",
      });
      await next();
    });
    app.post("/tickets/:id/transitions", ...executeThirdPartyTransitionHandler);

    const res = await postTransition(app, creatorTicketId);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body.message).toBe("Invalid token");
  });
});
