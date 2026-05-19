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
  WorkflowError,
} from "@platform/workflow-engine";
import type { AuthContext } from "@platform/auth";
import { executeTransitionHandler } from "../../src/routes/entities/execute-transition.js";

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
    { workflowId: workflowIdA, name: "open", label: "Open", sortOrder: 0 },
    {
      workflowId: workflowIdA,
      name: "closed",
      label: "Closed",
      isTerminal: true,
      sortOrder: 1,
    },
  ]);

  // States for B
  await db.insert(workflowStates).values([
    { workflowId: workflowIdB, name: "open", label: "Open", sortOrder: 0 },
    {
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
  it.skip("direct SELECT within Tenant A context returns no Tenant B rows (requires non-superuser role)", async () => {
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transitionId: transitionIdA }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("INSTANCE_NOT_FOUND");
  });
});
