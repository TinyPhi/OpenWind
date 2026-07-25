/**
 * Tenant isolation tests for the workflow engine.
 *
 * Uses a real Postgres database (no mocks) to verify that cross-tenant data
 * leakage is impossible across every public workflow engine API surface.
 * Mirrors the pattern in entity-engine.isolation.test.ts.
 *
 * Two isolated tenants (A and B) are created per suite. Each gets:
 *  - a workflow definition with one "open" → "closed" transition
 *  - an entity instance bound to that workflow
 *
 * After Tenant A's failed attempts, Tenant B's state must be unchanged.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, withTenantContext } from "@platform/db";
import {
  entityInstances,
  entityTypes,
  workflows,
  workflowStates,
  workflowTransitions,
  workflowEvents,
} from "@platform/db";
import {
  executeTransition,
  getAvailableTransitions,
  getWorkflowEventLog,
  createWorkflow,
  WorkflowError,
} from "@platform/workflow-engine";
import type { AuthContext } from "@platform/auth";
import { executeTransitionHandler } from "../../src/routes/entities/execute-transition.js";
import { createWorkflowHandler } from "../../src/routes/workflows/create.js";

// ── Test tenant IDs ───────────────────────────────────────────────────────────

const TENANT_A = "aaaaaaaa-0000-4000-a000-000000000011";
const TENANT_B = "bbbbbbbb-0000-4000-b000-000000000012";

// ── Shared state seeded in beforeAll ─────────────────────────────────────────

let entityTypeId: string;
let workflowIdA: string;
let workflowIdB: string;
let transitionIdA: string;
let transitionIdB: string;
let instanceIdA: string;
let instanceIdB: string;

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const ts = Date.now();

  // Shared entity type (tenant_id = null)
  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `isolation_wf_ticket_${ts}`,
      plural: `isolation_wf_tickets_${ts}`,
      allowCustomFields: true,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  // Workflow for Tenant A
  const [wfA] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_A,
      entityTypeId,
      name: "Tenant A Workflow",
      initialState: "open",
    })
    .returning();
  if (!wfA) throw new Error("workflow A insert failed");
  workflowIdA = wfA.id;

  // Workflow for Tenant B
  const [wfB] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_B,
      entityTypeId,
      name: "Tenant B Workflow",
      initialState: "open",
    })
    .returning();
  if (!wfB) throw new Error("workflow B insert failed");
  workflowIdB = wfB.id;

  // States for A
  await db.insert(workflowStates).values([
    {
      tenantId: TENANT_A,
      workflowId: workflowIdA,
      name: "open",
      label: "Open",
      sortOrder: 0,
    },
    {
      tenantId: TENANT_A,
      workflowId: workflowIdA,
      name: "closed",
      label: "Closed",
      isTerminal: true,
      sortOrder: 1,
    },
  ]);

  // States for B
  await db.insert(workflowStates).values([
    {
      tenantId: TENANT_B,
      workflowId: workflowIdB,
      name: "open",
      label: "Open",
      sortOrder: 0,
    },
    {
      tenantId: TENANT_B,
      workflowId: workflowIdB,
      name: "closed",
      label: "Closed",
      isTerminal: true,
      sortOrder: 1,
    },
  ]);

  // Transition for A
  const [tA] = await db
    .insert(workflowTransitions)
    .values({
      tenantId: TENANT_A,
      workflowId: workflowIdA,
      fromState: "open",
      toState: "closed",
      label: "Close",
      allowedRoles: [],
      requiresComment: false,
      requiresFields: [],
    })
    .returning();
  if (!tA) throw new Error("transition A insert failed");
  transitionIdA = tA.id;

  // Transition for B
  const [tB] = await db
    .insert(workflowTransitions)
    .values({
      tenantId: TENANT_B,
      workflowId: workflowIdB,
      fromState: "open",
      toState: "closed",
      label: "Close",
      allowedRoles: [],
      requiresComment: false,
      requiresFields: [],
    })
    .returning();
  if (!tB) throw new Error("transition B insert failed");
  transitionIdB = tB.id;

  // Entity instances bound to their respective workflows
  const [instA] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT_A,
      entityTypeId,
      workflowId: workflowIdA,
      currentState: "open",
      fields: {},
    })
    .returning();
  if (!instA) throw new Error("instance A insert failed");
  instanceIdA = instA.id;

  const [instB] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT_B,
      entityTypeId,
      workflowId: workflowIdB,
      currentState: "open",
      fields: {},
    })
    .returning();
  if (!instB) throw new Error("instance B insert failed");
  instanceIdB = instB.id;
});

afterAll(async () => {
  // Clean up in FK dependency order
  await db
    .delete(workflowEvents)
    .where(eq(workflowEvents.instanceId, instanceIdA));
  await db
    .delete(workflowEvents)
    .where(eq(workflowEvents.instanceId, instanceIdB));
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));
  await db
    .delete(workflowTransitions)
    .where(eq(workflowTransitions.workflowId, workflowIdA));
  await db
    .delete(workflowTransitions)
    .where(eq(workflowTransitions.workflowId, workflowIdB));
  await db
    .delete(workflowStates)
    .where(eq(workflowStates.workflowId, workflowIdA));
  await db
    .delete(workflowStates)
    .where(eq(workflowStates.workflowId, workflowIdB));
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT_A));
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT_B));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
});

// ── executeTransition isolation ───────────────────────────────────────────────

describe("executeTransition — cross-tenant isolation", () => {
  it("throws INSTANCE_NOT_FOUND when Tenant A uses Tenant B instance ID", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      await expect(
        executeTransition(tx, TENANT_A, {
          instanceId: instanceIdB,
          transitionId: transitionIdA,
          triggeredBy: "user",
        }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof WorkflowError && e.code === "INSTANCE_NOT_FOUND",
      );
    });
  });

  it("Tenant B instance state is unchanged after Tenant A's failed attempt", async () => {
    // Attempt already failed in the test above; verify current state
    const [row] = await db
      .select({ currentState: entityInstances.currentState })
      .from(entityInstances)
      .where(eq(entityInstances.id, instanceIdB));
    expect(row?.currentState).toBe("open");
  });

  it("Tenant A can execute a transition on its own instance", async () => {
    const event = await withTenantContext(TENANT_A, (tx) =>
      executeTransition(tx, TENANT_A, {
        instanceId: instanceIdA,
        transitionId: transitionIdA,
        triggeredBy: "user",
        idempotencyKey: "isolation-test-key",
      }),
    );
    expect(event.instanceId).toBe(instanceIdA);
    expect(event.toState).toBe("closed");
  });
});

// ── getAvailableTransitions isolation ─────────────────────────────────────────

describe("getAvailableTransitions — cross-tenant isolation", () => {
  it("returns [] when Tenant A queries Tenant B instance ID", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const result = await getAvailableTransitions(
        tx,
        TENANT_A,
        instanceIdB,
        [],
      );
      expect(result).toEqual([]);
    });
  });

  it("returns B's transitions when Tenant B queries its own instance", async () => {
    await withTenantContext(TENANT_B, async (tx) => {
      const result = await getAvailableTransitions(
        tx,
        TENANT_B,
        instanceIdB,
        [],
      );
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]?.id).toBe(transitionIdB);
    });
  });
});

// ── getWorkflowEventLog isolation ─────────────────────────────────────────────

describe("getWorkflowEventLog — cross-tenant isolation", () => {
  it("returns [] when Tenant A queries Tenant B instance ID", async () => {
    // First produce an event for Tenant B so there is something to leak
    await withTenantContext(TENANT_B, (tx) =>
      executeTransition(tx, TENANT_B, {
        instanceId: instanceIdB,
        transitionId: transitionIdB,
        triggeredBy: "user",
        idempotencyKey: "isolation-event-key",
      }),
    );

    await withTenantContext(TENANT_A, async (tx) => {
      const events = await getWorkflowEventLog(tx, TENANT_A, instanceIdB);
      expect(events).toEqual([]);
    });
  });

  it("Tenant B can read its own event log", async () => {
    await withTenantContext(TENANT_B, async (tx) => {
      const events = await getWorkflowEventLog(tx, TENANT_B, instanceIdB);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.instanceId === instanceIdB)).toBe(true);
    });
  });
});

// ── RLS direct SELECT isolation ───────────────────────────────────────────────

describe("RLS — direct query on workflow_events within tenant context", () => {
  // withTenantContext now issues SET LOCAL ROLE app_user (#121), so RLS
  // applies even though CI connects as the `platform` superuser.
  it("direct SELECT within Tenant A context returns no Tenant B rows", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({
          id: workflowEvents.id,
          instanceId: workflowEvents.instanceId,
        })
        .from(workflowEvents)
        .where(eq(workflowEvents.instanceId, instanceIdB));
      expect(rows).toHaveLength(0);
    });
  });

  it("direct SELECT for own events succeeds within context", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: workflowEvents.id })
        .from(workflowEvents)
        .where(eq(workflowEvents.instanceId, instanceIdA));
      expect(rows.length).toBeGreaterThan(0);
    });
  });
});

// ── HTTP route-level isolation ─────────────────────────────────────────────────

describe("POST /entities/:id/transitions — HTTP cross-tenant isolation", () => {
  function makeApp(tenantId: string, userId: string, roles: string[]) {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use(
      "*",
      async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
        c.set("auth", { tenantId, userId, roles, email: "test@example.com" });
        await next();
      },
    );
    app.post("/:id/transitions", ...executeTransitionHandler);
    return app;
  }

  it("returns 404 when Tenant A POSTs to Tenant B instance ID", async () => {
    const app = makeApp(TENANT_A, "u-aaa", ["admin"]);

    const res = await app.request(`/${instanceIdB}/transitions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // sk_ prefix bypasses Zitadel introspection check; auth context is
        // already pre-set by the makeApp fixture middleware above.
        Authorization: "Bearer sk_test_isolation_bypass",
      },
      body: JSON.stringify({ transitionId: transitionIdA }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("INSTANCE_NOT_FOUND");
  });
});

// ── Entity-type ownership (issue #168 / ADR-006 Known gap #3) ────────────────
//
// Before migration 0036, createWorkflow was an unconditional INSERT with no
// check that entityTypeId wasn't already governed by another workflow, and
// no DB uniqueness constraint stopped it. A plain user-role tenant member
// could create a "shadow" workflow against an entity type they had no
// relationship to, and getWorkflowByEntityTypeId's unordered SELECT ... LIMIT
// 1 made which workflow "won" for listing/field-mutation authorization
// undefined. These tests reproduce that exact scenario against the fix.

describe("createWorkflow — entity-type ownership (issue #168)", () => {
  let ownershipEntityTypeId: string;
  const OWNER_TENANT = "cccccccc-0000-4000-c000-000000000168";
  const ATTACKER_TENANT = "dddddddd-0000-4000-d000-000000000168";

  beforeAll(async () => {
    const ts = Date.now();
    const [etRow] = await db
      .insert(entityTypes)
      .values({
        tenantId: null,
        name: `isolation_wf_ownership_${ts}`,
        plural: `isolation_wf_ownerships_${ts}`,
        allowCustomFields: true,
      })
      .returning();
    if (!etRow) throw new Error("entity type insert failed");
    ownershipEntityTypeId = etRow.id;
  });

  afterAll(async () => {
    await db
      .delete(workflows)
      .where(eq(workflows.entityTypeId, ownershipEntityTypeId));
    await db
      .delete(entityTypes)
      .where(eq(entityTypes.id, ownershipEntityTypeId));
  });

  it("creates the first workflow for an entity type successfully", async () => {
    const workflow = await withTenantContext(OWNER_TENANT, (tx) =>
      createWorkflow(tx, OWNER_TENANT, "legit-owner", {
        entityTypeId: ownershipEntityTypeId,
        name: "Legitimate Workflow",
        initialState: "open",
      }),
    );
    expect(workflow.entityTypeId).toBe(ownershipEntityTypeId);
    expect(workflow.createdBy).toBe("legit-owner");
  });

  it("rejects a second workflow against the same entity type in the same tenant", async () => {
    await withTenantContext(OWNER_TENANT, async (tx) => {
      await expect(
        createWorkflow(tx, OWNER_TENANT, "attacker-in-same-tenant", {
          entityTypeId: ownershipEntityTypeId,
          name: "Shadow Workflow",
          initialState: "open",
        }),
      ).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof WorkflowError &&
          e.code === "ENTITY_TYPE_ALREADY_GOVERNED",
      );
    });
  });

  it("the legitimate workflow is unaffected after the rejected attempt", async () => {
    const rows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.entityTypeId, ownershipEntityTypeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdBy).toBe("legit-owner");
  });

  it("a different tenant can still create its own workflow for the same entity type", async () => {
    // Uniqueness is scoped per-tenant, not global — every tenant installing
    // the same module (same shared entity type) must be able to create its
    // own workflow independently.
    const workflow = await withTenantContext(ATTACKER_TENANT, (tx) =>
      createWorkflow(tx, ATTACKER_TENANT, "other-tenant-owner", {
        entityTypeId: ownershipEntityTypeId,
        name: "Other Tenant's Workflow",
        initialState: "open",
      }),
    );
    expect(workflow.entityTypeId).toBe(ownershipEntityTypeId);
    expect(workflow.tenantId).toBe(ATTACKER_TENANT);

    await db.delete(workflows).where(eq(workflows.tenantId, ATTACKER_TENANT));
  });
});

describe("POST /workflows — HTTP entity-type ownership (issue #168)", () => {
  function makeApp(tenantId: string, userId: string, roles: string[]) {
    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    app.use(
      "*",
      async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
        c.set("auth", { tenantId, userId, roles, email: "test@example.com" });
        await next();
      },
    );
    app.post("/", ...createWorkflowHandler);
    return app;
  }

  const HTTP_TENANT = "eeeeeeee-0000-4000-e000-000000000168";
  let httpEntityTypeId: string;

  beforeAll(async () => {
    const ts = Date.now();
    const [etRow] = await db
      .insert(entityTypes)
      .values({
        tenantId: null,
        name: `isolation_wf_http_ownership_${ts}`,
        plural: `isolation_wf_http_ownerships_${ts}`,
        allowCustomFields: true,
      })
      .returning();
    if (!etRow) throw new Error("entity type insert failed");
    httpEntityTypeId = etRow.id;
  });

  afterAll(async () => {
    await db
      .delete(workflows)
      .where(eq(workflows.entityTypeId, httpEntityTypeId));
    await db.delete(entityTypes).where(eq(entityTypes.id, httpEntityTypeId));
  });

  it("rejects a plain user-role caller with 403 — POST /workflows is admin/agent only (issue #168)", async () => {
    // Closes the first-claim lockout risk: opening creation to plain
    // `user`-role callers would let any tenant member race to squat a
    // freshly-created entity type. `user`-role delegation still works via
    // assignedTo[] (see the ownership-model tests above), just not via
    // creation itself.
    const app = makeApp(HTTP_TENANT, "plain-user", ["user"]);
    const res = await app.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk_test_isolation_bypass",
      },
      body: JSON.stringify({
        entityTypeId: httpEntityTypeId,
        name: "Attempted Workflow",
        initialState: "open",
      }),
    });
    expect(res.status).toBe(403);

    const rows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.entityTypeId, httpEntityTypeId));
    expect(rows).toHaveLength(0);
  });

  it("an agent creating a shadow workflow against an already-governed entity type gets 409, not a silent takeover", async () => {
    // First, a legitimate workflow already governs this entity type.
    const legitApp = makeApp(HTTP_TENANT, "legit-owner", ["agent"]);
    const legitRes = await legitApp.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk_test_isolation_bypass",
      },
      body: JSON.stringify({
        entityTypeId: httpEntityTypeId,
        name: "Legitimate Workflow",
        initialState: "open",
      }),
    });
    expect(legitRes.status).toBe(201);

    // A second agent with no relationship to this entity type attempts the
    // exact #168 attack: claim it via POST /workflows.
    const attackerApp = makeApp(HTTP_TENANT, "attacker", ["agent"]);
    const attackRes = await attackerApp.request("/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk_test_isolation_bypass",
      },
      body: JSON.stringify({
        entityTypeId: httpEntityTypeId,
        name: "Shadow Workflow",
        initialState: "open",
      }),
    });

    expect(attackRes.status).toBe(409);
    const json = await attackRes.json();
    expect(json.error).toBe("ENTITY_TYPE_ALREADY_GOVERNED");

    // Exactly one workflow exists for this entity type — no shadow row landed.
    const rows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.entityTypeId, httpEntityTypeId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdBy).toBe("legit-owner");
  });
});
