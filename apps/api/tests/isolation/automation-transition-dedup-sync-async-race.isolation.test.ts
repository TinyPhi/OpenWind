/**
 * #143 Phase 2, T4/T6: proves the consumer-side dedup in executor.ts actually
 * prevents a rule's action from running twice when the SAME transition is
 * seen through both paths that can now deliver it — the sync in-process
 * recursive call (packages/automation-engine/src/actions/transition.ts,
 * #120's original double-trigger guard) and a simulated async outbox->worker
 * consumption of the exact same outbox row engine.ts wrote for that
 * transition (apps/worker/src/automation-worker.ts's extraction pattern,
 * reproduced here without spinning up BullMQ — see
 * automation-depth-recursion.isolation.test.ts for the same style of direct
 * executeAutomationRules call standing in for "the worker dequeued this").
 *
 * Builds on the exact open->processing->done / "auto-continue" fixture from
 * automation-depth-recursion.isolation.test.ts, adding a second rule with an
 * observable, independently-idempotency-keyed side effect (a `notify` action
 * with a real recipientId) so a dedup bug that still ran the action a second
 * time — not just a dedup bug that only failed to insert a second
 * automation_executions row — would also be caught.
 *
 * See docs/specs/outbox-automation-idempotent-consumption.md (T6) and
 * docs/specs/outbox-automation-idempotent-consumption-tasks.md.
 *
 * Scope note (PR #380 review): this proves SEQUENTIAL dedup — the sync path
 * runs to completion and commits, then the "async" path is fed the same
 * transitionEventId and finds the existing 'success' row. It does NOT
 * exercise the advisory lock's actual blocking behavior (two genuinely
 * concurrent Postgres connections racing on pg_advisory_xact_lock, one
 * blocked until the other commits) — that requires two separate connections
 * held open past lock acquisition, which this single-process test doesn't
 * attempt. The lock's blocking semantics are documented PostgreSQL behavior,
 * not re-verified here; a true concurrent-connections test is tracked
 * separately — see automation-transition-dedup-concurrent-lock.isolation.test.ts
 * (issue #382).
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
  notifications,
  notificationRecipients,
  tenants,
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

const TENANT = "ffffffff-0000-4000-f000-000000000143";
const RECIPIENT = "u-t6-race-recipient";

let entityType: EntityType;
let workflowId: string;
let openToProcessingId: string;
let processingToDoneId: string;
let notifyRuleId: string;
let redis: Redis;

// Mirrors apps/worker/src/automation-worker.ts's readDepth/readTransitionEventId
// helpers exactly — extracts what the async path would extract from an
// outbox row's payload, without needing a live BullMQ worker for this test.
function readDepth(payload: unknown): number {
  return OutboxDepthSchema.safeParse(payload).data?.depth ?? 0;
}
function readTransitionEventId(payload: unknown): string | undefined {
  return OutboxTransitionEventIdSchema.safeParse(payload).data
    ?.transitionEventId;
}

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // Required by notifications.tenant_id's FK — unlike entity_types/workflows,
  // notifications was added after tenant FKs became the norm for new tables.
  await db.insert(tenants).values({
    id: TENANT,
    name: "T6 sync-async race test",
    slug: `t6-race-${TENANT}`,
  });
  entityType = await createEntityType(db, TENANT, {
    name: `t6_race_ticket_${Date.now()}`,
    plural: "t6_race_tickets",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `t6_race_workflow_${Date.now()}`,
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
  // transition it to "done" via automation — this is what produces the
  // automation-triggered transition (and its outbox row) T6 races against.
  await createAutomationRule(db, TENANT, {
    name: "T6 auto-continue to done",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: { op: "eq", field: "toState", value: "processing" },
    actions: [
      { type: "transition", config: { transitionId: processingToDoneId } },
    ],
  });

  // The rule under test: an observable side effect (notify) whose own
  // idempotency key (deriveNotificationId, notify.ts) is derived from
  // outboxEventId ?? execId — NOT from transitionEventId — so it cannot
  // accidentally mask a T4 dedup bug by coincidentally deduping itself the
  // same way.
  const notifyRule = await createAutomationRule(db, TENANT, {
    name: "T6 notify on done",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: { op: "eq", field: "toState", value: "done" },
    actions: [
      {
        type: "notify",
        config: { recipientId: RECIPIENT, payload: { title: "Done" } },
      },
    ],
  });
  notifyRuleId = notifyRule.id;
});

afterAll(async () => {
  await redis.quit();
  await withTenantContext(TENANT, async (tx) => {
    await tx
      .delete(notificationRecipients)
      .where(eq(notificationRecipients.tenantId, TENANT));
    await tx.delete(notifications).where(eq(notifications.tenantId, TENANT));
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
  await db.delete(tenants).where(eq(tenants.id, TENANT));
});

describe("executor.ts dedup prevents a duplicate rule execution on a sync/async race for the same transition (#143 T6)", () => {
  it("a rule fires exactly once — one success row, one notification — even when the same transitionEventId is fed through both the sync in-process path and a simulated async re-consumption", async () => {
    const instance = await withTenantContext(TENANT, (tx) =>
      createEntity(tx, TENANT, {
        entityTypeId: entityType.id,
        fields: {},
        workflowId,
      }),
    );

    // Root, user-triggered transition into "processing".
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

    // SYNC PATH: simulate the worker dequeuing the root event. This drives
    // the "auto-continue to done" rule's transition action, which recurses
    // in-process (transition.ts) into the "notify on done" rule — this is
    // the FIRST completion of (notifyRuleId, transitionEventId-of-the-
    // automation-triggered transition).
    await executeAutomationRules(db, TENANT, rootRow?.payload, 0, redis);

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
    const doneTransitionEventId = readTransitionEventId(doneRow?.payload);
    expect(doneTransitionEventId).toMatch(/^[0-9a-f-]{36}$/);

    // Sanity: the sync path already completed exactly one execution for the
    // notify rule before we ever touch the "async" side of the race.
    const afterSync = await db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.tenantId, TENANT),
          eq(automationExecutions.ruleId, notifyRuleId),
        ),
      );
    expect(afterSync).toHaveLength(1);
    expect(afterSync[0]?.status).toBe("success");

    // ASYNC PATH (simulated): feed the SAME outbox row automation-worker.ts
    // would eventually dequeue for this exact transition — same
    // transitionEventId, extracted the same way readDepth/
    // readTransitionEventId do in apps/worker/src/automation-worker.ts.
    await executeAutomationRules(
      db,
      TENANT,
      doneRow?.payload,
      readDepth(doneRow?.payload),
      redis,
      doneRow?.id,
      doneTransitionEventId,
    );

    // Still exactly one execution row for this (ruleId, transitionEventId) —
    // T4's advisory-lock-guarded dedup skipped the second attempt entirely.
    const afterAsync = await db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.tenantId, TENANT),
          eq(automationExecutions.ruleId, notifyRuleId),
          eq(automationExecutions.transitionEventId, doneTransitionEventId!),
        ),
      );
    expect(afterAsync).toHaveLength(1);
    expect(afterAsync[0]?.status).toBe("success");

    // The notify action's own side effect fired exactly once — proves the
    // dedup skip happened BEFORE the action ran, not just before the second
    // automation_executions row was inserted.
    const sentNotifications = await db
      .select()
      .from(notificationRecipients)
      .where(
        and(
          eq(notificationRecipients.tenantId, TENANT),
          eq(notificationRecipients.userId, RECIPIENT),
        ),
      );
    expect(sentNotifications).toHaveLength(1);
  });
});
