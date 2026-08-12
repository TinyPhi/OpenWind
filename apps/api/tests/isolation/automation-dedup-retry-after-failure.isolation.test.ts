/**
 * #143 Phase 2, T4/T8: proves a 'failed' automation_executions row for a
 * given (ruleId, transitionEventId) never permanently blocks a legitimate
 * retry of the same pair — only the partial unique index's `status =
 * 'success'` scope matters to the dedup check (executor.ts), by design (see
 * docs/specs/outbox-automation-idempotent-consumption.md §V: "status:
 * 'failed' rows are deliberately persisted... a blanket index would
 * permanently block any retry of a failed execution").
 *
 * Forces a deterministic first-attempt failure via a `set_field` action
 * misconfigured to target a non-existent instanceId (entity-engine's
 * updateEntity throws ENTITY_NOT_FOUND), then fixes the rule's own action
 * config before retrying with the SAME transitionEventId (simulating a
 * BullMQ retry of the same job) — modeling "the config gets corrected"
 * rather than depending on network/timing flakiness for a transient
 * failure, while still exercising exactly the dedup property under test:
 * a prior 'failed' status must never block a later 'success'.
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
  entityFields,
} from "@platform/db";
import { env } from "@platform/config";
import {
  createEntityType,
  createEntity,
  getEntity,
  addEntityField,
} from "@platform/entity-engine";
import type { EntityType } from "@platform/entity-engine";
import {
  createWorkflow,
  addWorkflowState,
  addWorkflowTransition,
  executeTransition,
} from "@platform/workflow-engine";
import {
  createAutomationRule,
  updateAutomationRule,
  executeAutomationRules,
} from "@platform/automation-engine";

const TENANT = "ffffffff-0000-4000-f000-000000000145";
const BOGUS_INSTANCE_ID = "00000000-0000-4000-8000-000000000000";

let entityType: EntityType;
let workflowId: string;
let openToProcessingId: string;
let setFieldRuleId: string;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  entityType = await createEntityType(db, TENANT, {
    name: `t8_retry_ticket_${Date.now()}`,
    plural: "t8_retry_tickets",
    allowCustomFields: true,
  });

  // allowCustomFields only governs whether new field definitions may be
  // registered — the update-schema validation set_field's updateEntity call
  // goes through (getValidationSchema, entity-engine's engine.ts) only
  // recognizes fields present in entity_fields, silently stripping anything
  // else. Without registering "priority" here, the retry's set_field action
  // would report status: 'success' while writing nothing.
  await addEntityField(db, TENANT, entityType.id, {
    name: "priority",
    label: "Priority",
    fieldType: "text",
    config: {},
    isRequired: false,
    isIndexed: false,
    isSystem: false,
    sortOrder: 0,
    sensitivity: "public",
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `t8_retry_workflow_${Date.now()}`,
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
    isTerminal: true,
    sortOrder: 1,
  });

  const openToProcessing = await addWorkflowTransition(
    db,
    TENANT,
    workflowId,
    caller,
    { fromState: "open", toState: "processing" },
  );
  openToProcessingId = openToProcessing.id;

  // Deliberately broken on creation: instanceId points nowhere, so
  // executeSetFieldAction's updateEntity call always throws ENTITY_NOT_FOUND
  // until the test fixes the config below.
  const setFieldRule = await createAutomationRule(db, TENANT, {
    name: "T8 set priority (misconfigured)",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: { op: "eq", field: "toState", value: "processing" },
    actions: [
      {
        type: "set_field",
        config: {
          field: "priority",
          value: "high",
          instanceId: BOGUS_INSTANCE_ID,
        },
      },
    ],
  });
  setFieldRuleId = setFieldRule.id;
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
    // entityFields before entityTypes — entity_fields.entity_type_id has no
    // ON DELETE CASCADE, so deleting entityTypes first would FK-violate.
    await tx.delete(entityFields).where(eq(entityFields.tenantId, TENANT));
    await tx.delete(entityTypes).where(eq(entityTypes.tenantId, TENANT));
  });
});

describe("a 'failed' execution for (ruleId, transitionEventId) does not block a later retry (#143 T8)", () => {
  it("fails on the first attempt, then completes successfully on a same-transitionEventId retry after the rule is fixed", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
        workflowId,
      }),
    );

    await withTenantContext(TENANT, (tx) =>
      executeTransition(tx, TENANT, {
        instanceId: instance.id,
        transitionId: openToProcessingId,
        triggeredBy: "user",
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
    const transitionEventId = (row?.payload as Record<string, unknown>)
      .transitionEventId as string;
    expect(transitionEventId).toMatch(/^[0-9a-f-]{36}$/);

    // Attempt 1: acquires the lock, finds no success row, runs, fails.
    await executeAutomationRules(
      db,
      TENANT,
      row?.payload,
      0,
      redis,
      row?.id,
      transitionEventId,
    );

    const afterFirst = await db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.tenantId, TENANT),
          eq(automationExecutions.ruleId, setFieldRuleId),
          eq(automationExecutions.transitionEventId, transitionEventId),
        ),
      );
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.status).toBe("failed");
    // executor.ts stores actionError.message, and AutomationError's
    // constructor (types.ts) calls super(code) — so .message === .code by
    // construction. This assertion is coupled to that; if AutomationError
    // is ever changed to build a human-readable message separately from its
    // stable .code enum, this would need to change too (PR #380 review, LOW).
    expect(afterFirst[0]?.error).toBe("ENTITY_NOT_FOUND");

    // Fix the rule — same shape of change a human/admin would make after
    // seeing the failure. executeAutomationRules re-queries automationRules
    // fresh on every call, so the retry below picks this up.
    await updateAutomationRule(db, TENANT, setFieldRuleId, {
      actions: [
        { type: "set_field", config: { field: "priority", value: "high" } },
      ],
    });

    // Attempt 2 (simulated BullMQ retry of the same job — SAME
    // transitionEventId): acquires the lock, finds only the 'failed' row
    // (not 'success'), so proceeds instead of skipping.
    await executeAutomationRules(
      db,
      TENANT,
      row?.payload,
      0,
      redis,
      row?.id,
      transitionEventId,
    );

    const afterRetry = await db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.tenantId, TENANT),
          eq(automationExecutions.ruleId, setFieldRuleId),
          eq(automationExecutions.transitionEventId, transitionEventId),
        ),
      );
    // The failed row from attempt 1 is untouched (still there) and a NEW
    // successful row now exists alongside it — the partial unique index
    // (WHERE status = 'success') never objected because only one 'success'
    // row exists for this pair.
    expect(afterRetry).toHaveLength(2);
    expect(afterRetry.filter((r) => r.status === "failed")).toHaveLength(1);
    expect(afterRetry.filter((r) => r.status === "success")).toHaveLength(1);

    // And the retry's action genuinely ran, not just recorded as if it had.
    const updated = await withTenantContext(TENANT, (tx) =>
      getEntity(tx, TENANT, instance.id),
    );
    expect((updated?.fields as Record<string, unknown>).priority).toBe("high");
  });
});
