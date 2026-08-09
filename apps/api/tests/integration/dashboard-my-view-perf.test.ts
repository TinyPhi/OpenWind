/**
 * Perf smoke test for GET /dashboard/my-view — docs/specs/personal-dashboard.md §C:
 * "responds <500ms for a user w/ up to ~500 scoped tickets across ≤10 workflows".
 *
 * Seeds fixture rows directly (bypassing the API/engine) — this test is about the
 * endpoint's own query cost, not entity-creation cost. Requires a real Postgres
 * instance (no mocks).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import {
  db,
  entityTypes,
  entityInstances,
  workflows,
  workflowStates,
} from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { myViewHandler } from "../../src/routes/dashboard/my-view.js";

const TENANT = "aaaaaaaa-0000-4000-a000-000000000051";
const USER = "user-perf-dashboard-test";

const WORKFLOW_COUNT = 10;
const TICKETS_PER_WORKFLOW = 50; // 10 * 50 = 500 total, per §C's stated budget

let entityTypeIds: string[] = [];
let workflowIds: string[] = [];

beforeAll(async () => {
  const etRows = await db
    .insert(entityTypes)
    .values(
      Array.from({ length: WORKFLOW_COUNT }, (_, i) => ({
        tenantId: null,
        name: `perf_dashboard_type_${Date.now()}_${i}`,
        plural: `perf_dashboard_types_${Date.now()}_${i}`,
        allowCustomFields: true,
      })),
    )
    .returning({ id: entityTypes.id });
  entityTypeIds = etRows.map((r) => r.id);

  const wfRows = await db
    .insert(workflows)
    .values(
      entityTypeIds.map((entityTypeId) => ({
        tenantId: TENANT,
        entityTypeId,
        name: `Perf workflow ${entityTypeId.slice(0, 8)}`,
        initialState: "open",
        createdBy: USER,
      })),
    )
    .returning({ id: workflows.id });
  workflowIds = wfRows.map((r) => r.id);

  await db.insert(workflowStates).values(
    workflowIds.flatMap((workflowId) => [
      {
        tenantId: TENANT,
        workflowId,
        name: "open",
        label: "Open",
        slaHours: 1,
        sortOrder: 0,
      },
      {
        tenantId: TENANT,
        workflowId,
        name: "closed",
        label: "Closed",
        isTerminal: true,
        sortOrder: 1,
      },
    ]),
  );

  const instanceRows = [];
  for (let w = 0; w < workflowIds.length; w++) {
    for (let t = 0; t < TICKETS_PER_WORKFLOW; t++) {
      instanceRows.push({
        entityTypeId: entityTypeIds[w]!,
        tenantId: TENANT,
        workflowId: workflowIds[w]!,
        currentState: t % 2 === 0 ? "open" : "closed",
        fields: { title: `Perf ticket ${w}-${t}` },
        assignedTo: USER,
        // roughly half get a due date, spread across past/future, so the
        // dueDates section has real work to sort/cap too
        dueDate:
          t % 3 === 0 ? new Date(Date.now() + (t - 25) * 3_600_000) : null,
        // half the "open" rows are old enough to exceed sla_hours=1
        updatedAt:
          t % 2 === 0 ? new Date(Date.now() - 5 * 3_600_000) : new Date(),
      });
    }
  }
  await db.insert(entityInstances).values(instanceRows);
});

afterAll(async () => {
  await db
    .delete(entityInstances)
    .where(inArray(entityInstances.entityTypeId, entityTypeIds));
  await db
    .delete(workflowStates)
    .where(inArray(workflowStates.workflowId, workflowIds));
  await db.delete(workflows).where(inArray(workflows.id, workflowIds));
  await db.delete(entityTypes).where(inArray(entityTypes.id, entityTypeIds));
});

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: TENANT,
        userId: USER,
        roles: ["user"],
        email: "t@example.com",
      });
      await next();
    },
  );
  app.get("/my-view", ...myViewHandler);
  return app;
}

describe("GET /dashboard/my-view — perf (§C budget)", () => {
  it("responds within 500ms for 500 scoped tickets across 10 workflows", async () => {
    const app = makeApp();
    const start = performance.now();
    const res = await app.request("/my-view");
    const elapsedMs = performance.now() - start;

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { workflows: { total: number }[] };
    };
    const totalReturned = data.workflows.reduce((sum, w) => sum + w.total, 0);
    expect(totalReturned).toBe(WORKFLOW_COUNT * TICKETS_PER_WORKFLOW);
    expect(elapsedMs).toBeLessThan(500);
  });
});
