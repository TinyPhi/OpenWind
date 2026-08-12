/**
 * #143 Phase 2, T7: proves MAX_DEPTH (executor.ts, currently 10) actually
 * bounds recursion reached via the async outbox->worker path now that it's
 * live — before Phase 1 (#372), nothing ever populated `depth` on a
 * workflow.transitioned outbox payload, so this exact path was untestable
 * dead code (docs/specs/outbox-automation-idempotent-consumption-tasks.md,
 * T7). This does not exercise automation's own "transition" action (which
 * has its own, separate gap — see PROGRESS.md's "Open questions" — it never
 * forwards its own recursion depth into the TransitionRequest it builds, so
 * an automation-triggered transition's own outbox row currently carries no
 * depth at all); instead it constructs the depth-carrying outbox row
 * directly via `executeTransition`'s own `depth` request field (mirroring
 * how entity-created-depth.isolation.test.ts constructs its depth-9 fixture
 * via createEntity's `depth` param, rather than through the create_entity
 * automation action), then feeds it through a simulated async consumption —
 * exactly like automation-transition-dedup-sync-async-race
 * .isolation.test.ts's (T6) "ASYNC PATH (simulated)" step.
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
  OutboxDepthSchema,
  OutboxTransitionEventIdSchema,
} from "@platform/automation-engine";

// executor.ts's MAX_DEPTH is not exported (kept as an internal constant) —
// this mirrors executor.test.ts's own unit tests ("throws MAX_DEPTH_EXCEEDED
// at depth 10" / "does not throw at depth 9"), which hardcode the same
// literal for the same reason.
const MAX_DEPTH = 10;

const TENANT = "ffffffff-0000-4000-f000-000000000144";

let entityType: EntityType;
let workflowId: string;
let openToProcessingId: string;
let processingToDoneId: string;
let autoContinueRuleId: string;
let redis: Redis;

function readDepth(payload: unknown): number {
  return OutboxDepthSchema.safeParse(payload).data?.depth ?? 0;
}
function readTransitionEventId(payload: unknown): string | undefined {
  return OutboxTransitionEventIdSchema.safeParse(payload).data
    ?.transitionEventId;
}

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  entityType = await createEntityType(db, TENANT, {
    name: `t7_depth_ticket_${Date.now()}`,
    plural: "t7_depth_tickets",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `t7_depth_workflow_${Date.now()}`,
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

  // Auto-continue rule: reaching "processing" recursively transitions to
  // "done" via automation — the one hop this test needs to prove is bounded
  // when it starts already one hop short of MAX_DEPTH.
  const autoContinueRule = await createAutomationRule(db, TENANT, {
    name: "T7 auto-continue to done",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: { op: "eq", field: "toState", value: "processing" },
    actions: [
      { type: "transition", config: { transitionId: processingToDoneId } },
    ],
  });
  autoContinueRuleId = autoContinueRule.id;
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

describe("MAX_DEPTH is enforced on the async outbox->worker path (#143 T7)", () => {
  it("a depth: MAX_DEPTH - 1 outbox row, consumed via the worker path, fails the recursive hop with MAX_DEPTH_EXCEEDED instead of resetting to depth 0", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
        workflowId,
      }),
    );

    // Construct the outbox row directly at depth MAX_DEPTH - 1 — standing in
    // for "this transition is the 9th hop of some already-deep automation
    // chain" without needing to actually recurse 9 times to get there.
    await withTenantContext(TENANT, (tx) =>
      executeTransition(tx, TENANT, {
        instanceId: instance.id,
        transitionId: openToProcessingId,
        triggeredBy: "user",
        depth: MAX_DEPTH - 1,
      }),
    );

    const [row] = await withTenantContext(TENANT, (tx) =>
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
    expect(row).toBeDefined();
    expect((row?.payload as Record<string, unknown>).depth).toBe(MAX_DEPTH - 1);

    // Simulated async consumption, exactly as automation-worker.ts would do
    // it: readDepth(payload) recovers 9, not 0.
    const depth = readDepth(row?.payload);
    expect(depth).toBe(MAX_DEPTH - 1);

    // The top-level call itself must not throw — depth 9 is still < MAX_DEPTH.
    // The "auto-continue to done" rule matches and its transition action
    // recurses in-process at depth 10, which DOES trip the guard — caught by
    // executeAutomationRules's own per-rule try/catch (same as any other
    // action failure) and recorded as a 'failed' execution, not an unhandled
    // rejection of this call.
    await expect(
      executeAutomationRules(
        db,
        TENANT,
        row?.payload,
        depth,
        redis,
        row?.id,
        readTransitionEventId(row?.payload),
      ),
    ).resolves.toBeUndefined();

    const [execution] = await db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.tenantId, TENANT),
          eq(automationExecutions.ruleId, autoContinueRuleId),
        ),
      );
    expect(execution).toBeDefined();
    expect(execution?.status).toBe("failed");
    expect(execution?.error).toBe("MAX_DEPTH_EXCEEDED");

    // And the bound actually held: no processing->done transition, no
    // second-hop outbox row, ever got written — if depth had silently reset
    // to 0 instead of resuming at 9, this recursive hop would have succeeded.
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
    const doneRows = rows.filter(
      (r) => (r.payload as Record<string, unknown>).toState === "done",
    );
    expect(doneRows).toHaveLength(0);
  });
});
