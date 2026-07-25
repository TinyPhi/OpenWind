/**
 * Regression test for ADR-007: tenant-purge.ts's workflow-state/transition
 * deletion path (workflow_states/workflow_transitions, filtered by
 * `inArray(workflowId, wfIds)` rather than tenant_id — see the header comment
 * in tenant-purge.ts) must keep working once those two tables gain RLS.
 *
 * Uses a real Postgres database (no mocks on @platform/db), matching the
 * apps/api isolation test convention — mocking the database is prohibited per
 * testing-conventions.md. Only BullMQ (an external queue) is mocked, so the
 * processor can be invoked directly against a synthetic job.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  db,
  tenants,
  entityTypes,
  workflows,
  workflowStates,
  workflowTransitions,
} from "@platform/db";

// ── Mocks ─────────────────────────────────────────────────────────────────────

let capturedProcessor: ((job: unknown) => Promise<void>) | null = null;

// vitest 4.x: mockImplementation must use a regular function (not arrow) when
// the mock is used with `new` — arrow functions are not constructable.
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: (job: unknown) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

vi.mock("../../src/queues.js", () => ({ connection: {} }));

// ── Test tenant ───────────────────────────────────────────────────────────────

const TENANT_ID = "ffffffff-a000-4000-a000-000000000037";
let entityTypeId: string;
let workflowId: string;

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "ADR-007 tenant-purge regression tenant",
      slug: `adr-007-purge-regression-${Date.now()}`,
      status: "deleted",
    })
    .onConflictDoNothing();

  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: TENANT_ID,
      name: `adr007_purge_type_${Date.now()}`,
      plural: `adr007_purge_types_${Date.now()}`,
      allowCustomFields: false,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  const [wfRow] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT_ID,
      entityTypeId,
      name: "ADR-007 Purge Regression Workflow",
      initialState: "open",
    })
    .returning();
  if (!wfRow) throw new Error("workflow insert failed");
  workflowId = wfRow.id;

  await db.insert(workflowStates).values([
    {
      tenantId: TENANT_ID,
      workflowId,
      name: "open",
      label: "Open",
      sortOrder: 0,
    },
    {
      tenantId: TENANT_ID,
      workflowId,
      name: "closed",
      label: "Closed",
      isTerminal: true,
      sortOrder: 1,
    },
  ]);

  await db.insert(workflowTransitions).values({
    tenantId: TENANT_ID,
    workflowId,
    fromState: "open",
    toState: "closed",
    label: "Close",
  });

  // Import after mocks + fixtures so the captured processor is ready to run.
  await import("../../src/tenant-purge.js");
});

afterAll(async () => {
  // Best-effort cleanup in case an assertion failed before the purge itself
  // deleted these rows.
  await db
    .delete(workflowTransitions)
    .where(eq(workflowTransitions.workflowId, workflowId));
  await db
    .delete(workflowStates)
    .where(eq(workflowStates.workflowId, workflowId));
  await db.delete(workflows).where(eq(workflows.tenantId, TENANT_ID));
  await db.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("tenant-purge: workflow_states/workflow_transitions deletion under RLS (ADR-007)", () => {
  it("deletes workflow_states and workflow_transitions for the purged tenant without RLS blocking the write", async () => {
    expect(capturedProcessor).not.toBeNull();

    await capturedProcessor!({
      id: "adr-007-purge-regression-job",
      attemptsMade: 1,
      opts: { attempts: 3 },
      data: { tenantId: TENANT_ID },
    });

    const remainingStates = await db
      .select({ id: workflowStates.id })
      .from(workflowStates)
      .where(eq(workflowStates.workflowId, workflowId));
    expect(remainingStates).toHaveLength(0);

    const remainingTransitions = await db
      .select({ id: workflowTransitions.id })
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, workflowId));
    expect(remainingTransitions).toHaveLength(0);

    const [tenantRow] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .limit(1);
    expect(tenantRow?.status).toBe("purged");
  });
});
