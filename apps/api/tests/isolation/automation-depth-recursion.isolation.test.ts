/**
 * Proves #120's double-trigger fix still holds under #143's revised design:
 * an automation-triggered transition now DOES write a workflow.transitioned
 * outbox row (previously skipped — that skip is what #143 found silently
 * broke Phase 3A connector delivery), but a rule matching that transition
 * still fires exactly once, not twice — once synchronously (correctly
 * depth-bounded, via the in-process recursive call) and, in this specific
 * test, never a second time because nothing here feeds the new outbox row
 * back through executeAutomationRules. The test that actually does that
 * second hop (T6, Phase 2 — not yet implemented) will prove the
 * consumer-side dedup (transitionEventId + advisory lock, executor.ts)
 * catches it; see docs/specs/outbox-automation-idempotent-consumption.md.
 * See packages/workflow-engine/src/engine.ts's executeTransition.
 *
 * See entity-assigned-depth.isolation.test.ts for #120's other half: carrying
 * depth through the outbox so MAX_DEPTH survives the async worker hop.
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

const TENANT = "ffffffff-0000-4000-f000-000000000120";

let entityType: EntityType;
let workflowId: string;
let openToProcessingId: string;
let processingToDoneId: string;
let doneRuleId: string;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  entityType = await createEntityType(db, TENANT, {
    name: `depth_ticket_${Date.now()}`,
    plural: "depth_tickets",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `depth_workflow_${Date.now()}`,
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
    {
      fromState: "open",
      toState: "processing",
    },
  );
  openToProcessingId = openToProcessing.id;

  const processingToDone = await addWorkflowTransition(
    db,
    TENANT,
    workflowId,
    caller,
    {
      fromState: "processing",
      toState: "done",
    },
  );
  processingToDoneId = processingToDone.id;

  // Auto-continue rule: whenever anything reaches "processing", immediately
  // transition it to "done" via automation (the exact pattern #120 is about).
  await createAutomationRule(db, TENANT, {
    name: "Auto-continue to done",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: { op: "eq", field: "toState", value: "processing" },
    actions: [
      { type: "transition", config: { transitionId: processingToDoneId } },
    ],
  });

  // Counter rule: fires once per (real) arrival at "done".
  const doneRule = await createAutomationRule(db, TENANT, {
    name: "Count arrivals at done",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: { op: "eq", field: "toState", value: "done" },
    actions: [{ type: "notify", config: {} }],
  });
  doneRuleId = doneRule.id;
});

afterAll(async () => {
  await redis.quit();
  // Full cleanup, not just outboxEvents/automationExecutions (#360 root cause):
  // this test reuses a fixed TENANT id across every run. Anything left behind
  // here — especially automation_rules — survives on a long-lived local
  // Postgres instance and accumulates across repeated runs. Each leftover
  // "Auto-continue to done" rule still matches this test's real toState ==
  // "processing" event (the condition isn't scoped to a specific workflow),
  // so it re-fires against the CURRENT run's instance with its OWN stale
  // transitionId from a prior run's now-orphaned workflow. That transition
  // call fails, and after 5 such accumulated failures the circuit breaker
  // (packages/automation-engine/src/circuit-breaker.ts) opens for
  // (tenantId, "transition") and skips the current run's own — correctly
  // configured — rule too, since it sorts last by createdAt. CI never showed
  // this because its Postgres container is ephemeral per run; a long-lived
  // local dev container accumulates it after ~5 repeated runs. Now that #143
  // makes automation-triggered transitions write to the outbox too, leftover
  // outbox rows would compound the same way — deleting them here as well.
  // Deletion order respects FK dependencies (children before parents):
  // workflowEvents/entityInstances before workflows/entityTypes;
  // workflowStates/workflowTransitions before workflows.
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
    // tenantId filter, not id (PR #372 review, L2) — consistent with every
    // other delete above, and safe against a beforeAll failure leaving
    // entityType.id undefined (which would otherwise make this a no-op
    // WHERE id = NULL instead of erroring loudly).
    await tx.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  });
});

describe("automation-triggered transitions reach the outbox exactly once (#120, revised for #143)", () => {
  it("an automation-triggered transition writes a workflow.transitioned outbox row, and the matching rule still fires exactly once", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
        workflowId,
      }),
    );

    // Root, user-triggered transition — this one SHOULD still hit the outbox.
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

    // Simulate the worker dequeuing that root event — this is what actually
    // drives the "auto-continue to done" rule via the transition action.
    await executeAutomationRules(db, TENANT, rootRow?.payload, 0, redis);

    // The automation-triggered processing->done transition now DOES write its
    // own outbox row (#143 — previously skipped, silently missing every
    // outbox consumer other than automation itself). It carries a real
    // transitionEventId, which is what the consumer-side dedup (T4, Phase 2)
    // will eventually key on.
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
    expect(doneRows).toHaveLength(1);
    expect(
      (doneRows[0]?.payload as Record<string, unknown>).transitionEventId,
    ).toMatch(/^[0-9a-f-]{36}$/);

    // The counter rule still fired exactly once — via the in-process
    // recursive call. Nothing in this test consumes the new outbox row a
    // second time, so this doesn't yet exercise the dedup logic itself
    // (that's T6) — it only proves this phase didn't reintroduce #120's
    // symptom by the most obvious path (not calling the worker twice).
    const executions = await db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.tenantId, TENANT),
          eq(automationExecutions.ruleId, doneRuleId),
        ),
      );
    expect(executions).toHaveLength(1);
  });
});
