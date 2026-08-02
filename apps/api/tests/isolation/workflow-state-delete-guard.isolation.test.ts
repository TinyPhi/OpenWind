/**
 * Isolation test for #301 (split from #62): deleteWorkflowState only checked
 * whether a transition referenced the state being deleted — it never checked
 * whether a live entity instance was currently sitting in it. Uses a real
 * Postgres database (no mocks), matching this repo's testing convention.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@platform/db";
import {
  entityInstances,
  entityTypes,
  workflows,
  workflowStates,
} from "@platform/db";
import { deleteWorkflowState, WorkflowError } from "@platform/workflow-engine";

const TENANT = "cccccccc-0000-4000-c000-000000000013";
const CALLER = { userId: "user-owner", isGlobalAdmin: true };

let entityTypeId: string;
let workflowId: string;
let occupiedStateId: string;
let unusedStateId: string;
let instanceId: string;

beforeAll(async () => {
  const ts = Date.now();

  const [etRow] = await db
    .insert(entityTypes)
    .values({
      tenantId: null,
      name: `isolation_state_guard_${ts}`,
      plural: `isolation_state_guards_${ts}`,
      allowCustomFields: true,
    })
    .returning();
  if (!etRow) throw new Error("entity type insert failed");
  entityTypeId = etRow.id;

  const [wf] = await db
    .insert(workflows)
    .values({
      tenantId: TENANT,
      entityTypeId,
      name: "State Delete Guard Workflow",
      initialState: "open",
      createdBy: CALLER.userId,
    })
    .returning();
  if (!wf) throw new Error("workflow insert failed");
  workflowId = wf.id;

  // "open" has zero transitions referencing it and zero states that
  // transition into/out of it — the existing transition-reference guard
  // alone would let it be deleted. "abandoned" is a second, genuinely unused
  // state with no transitions AND no instances, proving the fix doesn't
  // regress the case that should still succeed.
  const [openState, abandonedState] = await db
    .insert(workflowStates)
    .values([
      {
        tenantId: TENANT,
        workflowId,
        name: "open",
        label: "Open",
        sortOrder: 0,
      },
      {
        tenantId: TENANT,
        workflowId,
        name: "abandoned",
        label: "Abandoned",
        sortOrder: 1,
      },
    ])
    .returning();
  if (!openState || !abandonedState) throw new Error("state insert failed");
  occupiedStateId = openState.id;
  unusedStateId = abandonedState.id;

  const [inst] = await db
    .insert(entityInstances)
    .values({
      tenantId: TENANT,
      entityTypeId,
      workflowId,
      currentState: "open",
      fields: {},
    })
    .returning();
  if (!inst) throw new Error("instance insert failed");
  instanceId = inst.id;
});

afterAll(async () => {
  await db
    .delete(entityInstances)
    .where(eq(entityInstances.entityTypeId, entityTypeId));
  await db
    .delete(workflowStates)
    .where(eq(workflowStates.workflowId, workflowId));
  await db.delete(workflows).where(eq(workflows.id, workflowId));
  await db.delete(entityTypes).where(eq(entityTypes.id, entityTypeId));
});

describe("deleteWorkflowState — instance-in-use guard (#301)", () => {
  it("throws WORKFLOW_STATE_IN_USE when a live instance currently sits in the state, even with zero transitions referencing it", async () => {
    await expect(
      deleteWorkflowState(db, TENANT, workflowId, occupiedStateId, CALLER),
    ).rejects.toThrow(WorkflowError);

    try {
      await deleteWorkflowState(
        db,
        TENANT,
        workflowId,
        occupiedStateId,
        CALLER,
      );
      throw new Error("expected deleteWorkflowState to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as InstanceType<typeof WorkflowError>).code).toBe(
        "WORKFLOW_STATE_IN_USE",
      );
    }

    // Confirm the instance's state truly wasn't touched by the rejected call.
    const [row] = await db
      .select({ currentState: entityInstances.currentState })
      .from(entityInstances)
      .where(eq(entityInstances.id, instanceId))
      .limit(1);
    expect(row?.currentState).toBe("open");
  });

  it("still allows deleting a state with zero transitions and zero instances", async () => {
    await expect(
      deleteWorkflowState(db, TENANT, workflowId, unusedStateId, CALLER),
    ).resolves.toBeUndefined();

    const [row] = await db
      .select({ id: workflowStates.id })
      .from(workflowStates)
      .where(eq(workflowStates.id, unusedStateId))
      .limit(1);
    expect(row).toBeUndefined();
  });
});
