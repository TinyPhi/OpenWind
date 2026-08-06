/**
 * Proves #120's double-trigger fix: an automation-triggered transition no
 * longer both writes a workflow.transitioned outbox row AND recurses
 * in-process for the same event — any rule matching that transition used to
 * fire twice, once synchronously (correctly depth-bounded) and once later
 * via outbox -> poller -> BullMQ -> worker (depth reset to 0, unbounded).
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
  await withTenantContext(TENANT, async (tx) => {
    await tx.delete(outboxEvents).where(eq(outboxEvents.tenantId, TENANT));
    await tx
      .delete(automationExecutions)
      .where(eq(automationExecutions.tenantId, TENANT));
  });
});

describe("automation-triggered transitions skip the outbox (#120)", () => {
  it("an automation-triggered transition writes no workflow.transitioned outbox row", async () => {
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

    // The automation-triggered processing->done transition must NOT have
    // written a second outbox row (that's the actual double-trigger source).
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

    // And the counter rule fired exactly once — via the in-process recursive
    // call, not twice (once in-process, once via a since-nonexistent outbox row).
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
