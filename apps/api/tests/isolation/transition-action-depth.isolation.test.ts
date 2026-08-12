/**
 * Regression test for #379: executeTransitionAction (packages/automation-
 * engine/src/actions/transition.ts) called executeTransition without a
 * `depth` field, unlike create-entity.ts's executeCreateEntityAction (which
 * does pass its own `depth` into createEntity). Since
 * packages/workflow-engine/src/engine.ts's executeTransition stamps
 * `request.depth` verbatim onto the workflow.transitioned outbox payload
 * (no +1 — unlike entity-engine's createEntity/updateEntity, which stamp
 * `depth + 1`), the missing field meant the transition action's OWN outbox
 * row always carried an undefined depth, silently resetting MAX_DEPTH
 * counting to 0 for anything that later consumed that row via the outbox
 * (e.g. a future Phase 3A connector, or the outbox poller after #378).
 *
 * Mirrors entity-created-depth.isolation.test.ts / entity-assigned-depth
 * .isolation.test.ts in structure and automation-depth-recursion.isolation
 * .test.ts's fixture (open -> processing -> done, "Auto-continue to done"
 * rule), but drives executeAutomationRules at a non-zero starting depth to
 * prove the transition action's own outbox row carries that same depth
 * forward instead of losing it.
 *
 * Depth is deliberately kept well below MAX_DEPTH (10): executeTransitionAction
 * recurses in-process into executeAutomationRules(followUpEvent, depth + 1, ...)
 * inside the same savepoint as the transition's own writes (workflow_events,
 * outbox_events) — if that recursive call itself trips MAX_DEPTH_EXCEEDED,
 * the whole savepoint (including the transition and its outbox row) rolls
 * back before this test could observe them. depth=6 keeps the follow-up
 * call at 7, safely clear of the boundary.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import Redis from "ioredis";
import {
  db,
  withTenantContext,
  outboxEvents,
  automationExecutions,
  automationRules,
  workflowEvents,
  entityInstances,
  workflowTransitions,
  workflowStates,
  workflows,
  entityTypes,
} from "@platform/db";
import { env } from "@platform/config";
import { createEntityType, createEntity } from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";
import {
  createWorkflow,
  addWorkflowState,
  addWorkflowTransition,
  executeTransition,
} from "@platform/workflow-engine";
import {
  createAutomationRule,
  executeAutomationRules,
} from "@platform/automation-engine";

const TENANT = "ffffffff-0000-4000-f000-000000000379";
const STARTING_DEPTH = 6;

let entityType: EntityType;
let workflowId: string;
let openToProcessingId: string;
let processingToDoneId: string;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  entityType = await createEntityType(db, TENANT, {
    name: `depth_transition_${Date.now()}`,
    plural: "depth_transitions",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `depth_transition_workflow_${Date.now()}`,
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
  await addWorkflowState(db, TENANT, workflowId, caller, {
    name: "done",
    label: "Done",
    isTerminal: true,
    sortOrder: 2,
  });

  const openToProcessing = await addWorkflowTransition(
    db,
    TENANT,
    workflowId,
    caller,
    { fromState: "open", toState: "processing" },
  );
  openToProcessingId = openToProcessing.id;

  const processingToDone = await addWorkflowTransition(
    db,
    TENANT,
    workflowId,
    caller,
    { fromState: "processing", toState: "done" },
  );
  processingToDoneId = processingToDone.id;

  // Auto-continue rule: whenever anything reaches "processing", immediately
  // transition it to "done" via automation — its "transition" action is the
  // one under test.
  await createAutomationRule(db, TENANT, {
    name: "Auto-continue to done (#379)",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: { op: "eq", field: "toState", value: "processing" },
    actions: [
      { type: "transition", config: { transitionId: processingToDoneId } },
    ],
  });
});

afterAll(async () => {
  await redis.quit();
  await withTenantContext(TENANT, async (tx) => {
    await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
    await tx
      .delete(automationExecutions)
      .where(eq(automationExecutions.tenantId, TENANT));
    await tx
      .delete(automationRules)
      .where(eq(automationRules.tenantId, TENANT));
    await tx.delete(workflowEvents).where(eq(workflowEvents.tenantId, TENANT));
    await tx
      .delete(entityInstances)
      .where(eq(entityInstances.tenantId, TENANT));
    await tx
      .delete(workflowTransitions)
      .where(eq(workflowTransitions.tenantId, TENANT));
    await tx.delete(workflowStates).where(eq(workflowStates.tenantId, TENANT));
    await tx.delete(workflows).where(eq(workflows.tenantId, TENANT));
    await tx.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  });
});

describe("transition action stamps depth on its own outbox row (#379)", () => {
  it("carries the triggering rule's non-zero depth onto the transition action's workflow.transitioned outbox payload", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
        workflowId,
      }),
    );

    // Root, user-triggered transition into "processing" — depth 0, as any
    // real user/API transition would be.
    await withTenantContext(TENANT, (tx) =>
      executeTransition(tx, TENANT, {
        instanceId: instance.id,
        transitionId: openToProcessingId,
        triggeredBy: "user",
      }),
    );

    const [rootRow] = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, TENANT),
            eq(outboxEvents.eventType, "workflow.transitioned"),
          ),
        ),
    );
    expect(rootRow).toBeDefined();

    // Simulate this root event being consumed at a NON-ZERO recursion depth
    // (as if it were itself several automation hops deep already) — this is
    // what makes executeTransitionAction's own `depth` parameter non-zero
    // when it runs the "processing" -> "done" transition below.
    await executeAutomationRules(
      db,
      TENANT,
      rootRow?.payload,
      STARTING_DEPTH,
      redis,
    );

    const rows = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.tenantId, TENANT),
            eq(outboxEvents.eventType, "workflow.transitioned"),
          ),
        ),
    );
    const doneRow = rows.find(
      (r) => (r.payload as Record<string, unknown>).toState === "done",
    );
    expect(doneRow).toBeDefined();

    // Before #379's fix, this was always undefined — the transition action
    // never passed `depth` into executeTransition's request at all.
    const depth = (doneRow?.payload as Record<string, unknown>).depth;
    expect(depth).toBe(STARTING_DEPTH);
    expect(depth).not.toBe(0);
    expect(depth).toBeDefined();
  });
});
