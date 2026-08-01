/**
 * Tenant isolation tests for PUT /workflows/:id/canvas.
 *
 * Verifies that Tenant A cannot modify Tenant B's workflow canvas —
 * the route must return 404 (not 403) to avoid leaking resource existence.
 *
 * Tests run against a real Postgres instance (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db } from "@platform/db";
import {
  workflows,
  workflowStates,
  workflowTransitions,
  entityTypes,
} from "@platform/db";
import { canvasSaveHandler } from "../../src/routes/workflows/canvas.js";
import type { AuthContext } from "@platform/auth";

// ── Test tenant IDs ─────────────────────────────────────────────────────────

const TENANT_A = "aaaaaaaa-4444-4000-a000-000000000041";
const TENANT_B = "bbbbbbbb-4444-4000-b000-000000000042";

// ── Shared state ─────────────────────────────────────────────────────────────

let entityTypeId: string;
let workflowIdA: string;
let workflowIdB: string;
let openStateIdA: string; // UUID primary key of Tenant A's "open" state

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const ts = Date.now();

  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `canvas_isolation_type_${ts}`,
      plural: `canvas_isolation_types_${ts}`,
      allowCustomFields: false,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  const [wfA] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_A,
      entityTypeId,
      name: "Canvas Isolation Workflow A",
      initialState: "open",
    })
    .returning();
  if (!wfA) throw new Error("workflow A insert failed");
  workflowIdA = wfA.id;

  const [wfB] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_B,
      entityTypeId,
      name: "Canvas Isolation Workflow B",
      initialState: "open",
    })
    .returning();
  if (!wfB) throw new Error("workflow B insert failed");
  workflowIdB = wfB.id;

  const [stateA] = await db
    .insert(workflowStates)
    .values({
      tenantId: TENANT_A,
      workflowId: workflowIdA,
      name: "open",
      label: "Open",
      sortOrder: 0,
    })
    .returning();
  if (!stateA) throw new Error("state A insert failed");
  openStateIdA = stateA.id;

  await db.insert(workflowStates).values({
    tenantId: TENANT_B,
    workflowId: workflowIdB,
    name: "open",
    label: "Open",
    sortOrder: 0,
  });
});

// ── Teardown ─────────────────────────────────────────────────────────────────

afterAll(async () => {
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
  await db.delete(workflows).where(eq(workflows.id, workflowIdA));
  await db.delete(workflows).where(eq(workflows.id, workflowIdB));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
});

// ── HTTP fixture ──────────────────────────────────────────────────────────────

function makeApp(tenantId: string, userId: string, roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", { tenantId, userId, roles, email: "test@example.com" });
      await next();
    },
  );
  app.put("/:id/canvas", ...canvasSaveHandler);
  return app;
}

// Build a valid canvas body using the real UUID from the DB.
// The canvas handler compares state IDs against UUID primary keys, not names.
function validCanvasBody() {
  return {
    states: [
      {
        id: openStateIdA,
        name: "open",
        label: "Open",
        sortOrder: 0,
        isTerminal: false,
      },
    ],
    transitions: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PUT /workflows/:id/canvas — cross-tenant isolation", () => {
  it("returns 404 when Tenant A sends Tenant B workflow ID", async () => {
    const app = makeApp(TENANT_A, "u-aaa", ["admin"]);

    const res = await app.request(`/${workflowIdB}/canvas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validCanvasBody()),
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("WORKFLOW_NOT_FOUND");
  });

  it("Tenant B workflow state is unchanged after Tenant A's failed save attempt", async () => {
    const [row] = await db
      .select({ name: workflows.name })
      .from(workflows)
      .where(eq(workflows.id, workflowIdB));
    expect(row?.name).toBe("Canvas Isolation Workflow B");
  });

  it("returns 200 when Tenant A saves its own workflow canvas", async () => {
    const app = makeApp(TENANT_A, "u-aaa", ["admin"]);

    const res = await app.request(`/${workflowIdA}/canvas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validCanvasBody()),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown };
    expect(json.data).toBeDefined();
  });
});

describe("PUT /workflows/:id/canvas — initial state deletion guard", () => {
  it("returns 422 when the save attempts to delete the initial state", async () => {
    const app = makeApp(TENANT_A, "u-aaa", ["admin"]);

    // Send an empty states array — drops the "open" initial state
    const res = await app.request(`/${workflowIdA}/canvas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states: [], transitions: [] }),
    });

    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("INVALID_OPERATION");
  });
});

describe("PUT /workflows/:id/canvas — role authorization", () => {
  it("returns 404 when a non-admin role attempts to save the canvas", async () => {
    const app = makeApp(TENANT_A, "u-agent", ["agent"]);

    const res = await app.request(`/${workflowIdA}/canvas`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validCanvasBody()),
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("NOT_FOUND");
  });
});
