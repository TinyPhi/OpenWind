/**
 * #378 follow-up to #143 Phase 2: now that outbox-poller.ts's temporary
 * exclusion for automation-triggered workflow.transitioned rows is removed
 * (see outbox-poller-automation-exclusion.isolation.test.ts), this proves
 * the poller's real SQL query (a) claims and enqueues those rows, AND (b)
 * that doing so is actually safe — a rule whose action already ran once via
 * the sync in-process recursive path (#120, transition.ts) still fires
 * exactly once end-to-end even when this poller ALSO picks up and delivers
 * the same outbox row for a second, async re-consumption of the identical
 * transition. executor.ts's consumer-side dedup (advisory lock + status =
 * 'success' check, keyed on (ruleId, transitionEventId), #143 Phase 2) is
 * what makes this safe.
 *
 * Fixture and dedup-proof shape mirror
 * apps/api/tests/isolation/automation-transition-dedup-sync-async-race
 * .isolation.test.ts (T6) exactly — open -> processing -> done, an
 * "auto-continue to done" transition rule, and a "notify on done" rule with
 * an observable, independently-idempotency-keyed side effect. The difference
 * from T6: instead of hand-rolling the second ("async") executeAutomationRules
 * call, this test drives it from the REAL, now-unblocked outbox-poller query
 * (only BullMQ's automationQueue.add is mocked, so the poller's own SQL claim
 * is exercised for real without needing a live queue) and then feeds the
 * captured job data through executeAutomationRules exactly the way
 * apps/worker/src/automation-worker.ts's real processor would.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

const mockAdd = vi.fn();

vi.mock("../../src/queues.js", () => ({
  automationQueue: { add: (...args: unknown[]) => mockAdd(...args) },
}));

const { startOutboxPoller, stopOutboxPoller } =
  await import("../../src/outbox-poller.js");

const TENANT = "ffffffff-0000-4000-f000-000000000378";
const RECIPIENT = "u-378-race-recipient";

let entityType: EntityType;
let workflowId: string;
let openToProcessingId: string;
let processingToDoneId: string;
let notifyRuleId: string;
let redis: Redis;

// Mirrors apps/worker/src/automation-worker.ts's readDepth/readTransitionEventId
// helpers exactly — extracts what the real worker processor would extract
// from a dequeued job's payload.
function readDepth(payload: unknown): number {
  return OutboxDepthSchema.safeParse(payload).data?.depth ?? 0;
}
function readTransitionEventId(payload: unknown): string | undefined {
  return OutboxTransitionEventIdSchema.safeParse(payload).data
    ?.transitionEventId;
}

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await db.insert(tenants).values({
    id: TENANT,
    name: "#378 outbox-poller dedup race test",
    slug: `pr378-dedup-race-${TENANT}`,
  });

  entityType = await createEntityType(db, TENANT, {
    name: `poller_race_ticket_${Date.now()}`,
    plural: "poller_race_tickets",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `poller_race_workflow_${Date.now()}`,
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
  // automation-triggered transition (and its outbox row) this test races
  // the poller against.
  await createAutomationRule(db, TENANT, {
    name: "#378 auto-continue to done",
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
  // accidentally mask a dedup bug by coincidentally deduping itself the
  // same way.
  const notifyRule = await createAutomationRule(db, TENANT, {
    name: "#378 notify on done",
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

describe("outbox-poller's real query + executor.ts dedup together prevent a double-fire on automation-triggered transitions (#378)", () => {
  it("the poller claims and enqueues the automation-triggered 'done' row, but replaying it through executeAutomationRules still yields exactly one success and one notification", async () => {
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

    // FIRST (legitimate) consumption of the root event — simulates the
    // worker dequeuing it. This drives the "auto-continue to done" rule's
    // transition action, which recurses in-process (transition.ts) into the
    // "notify on done" rule — the first completion of (notifyRuleId,
    // transitionEventId-of-the-automation-triggered-transition).
    await executeAutomationRules(db, TENANT, rootRow?.payload, 0, redis);

    const rowsAfterSync = await withTenantContext(TENANT, (tx) =>
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
    const doneRow = rowsAfterSync.find(
      (r) => (r.payload as Record<string, unknown>).toState === "done",
    );
    expect(doneRow).toBeDefined();
    expect(doneRow?.deliveredAt).toBeNull(); // not yet claimed by the poller
    const doneTransitionEventId = readTransitionEventId(doneRow?.payload);
    expect(doneTransitionEventId).toMatch(/^[0-9a-f-]{36}$/);

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

    // (a) Start the REAL poller. Its query (outbox-poller.ts, #378) no
    // longer excludes triggeredBy === "automation" rows — it should claim
    // and enqueue the "done" row like any other undelivered
    // workflow.transitioned row.
    startOutboxPoller(50);

    // #436: this loop sleeps up to 100*50ms=5000ms waiting for the real
    // poller to claim `doneRow`, plus a db.select() per iteration — that left
    // zero margin against vitest's default 5000ms per-test timeout under
    // backlog/contention, causing an opaque "Test timed out" failure
    // unrelated to any poller bug. This it()'s explicit timeout gives real
    // headroom; the loop's own 100-attempt bound still reports a clear
    // assertion failure below if delivery genuinely never happens.
    let claimedDoneRow: { deliveredAt: Date | null } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      [claimedDoneRow] = await db
        .select({ deliveredAt: outboxEvents.deliveredAt })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, doneRow!.id));
      if (claimedDoneRow?.deliveredAt) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await stopOutboxPoller();

    expect(claimedDoneRow?.deliveredAt).not.toBeNull();

    const doneJobCall = mockAdd.mock.calls.find(
      (call) =>
        (call[1] as { outboxEventId?: string }).outboxEventId === doneRow!.id,
    );
    expect(doneJobCall).toBeDefined();
    const jobData = doneJobCall![1] as {
      outboxEventId: string;
      payload: unknown;
    };

    // (b) SECOND (racing) consumption of the exact same outbox row, fed
    // through executeAutomationRules exactly the way
    // apps/worker/src/automation-worker.ts's real processor does —
    // readDepth/readTransitionEventId extraction and all.
    await executeAutomationRules(
      db,
      TENANT,
      jobData.payload,
      readDepth(jobData.payload),
      redis,
      jobData.outboxEventId,
      readTransitionEventId(jobData.payload),
    );

    // Still exactly one execution row for this (ruleId, transitionEventId) —
    // the advisory-lock-guarded dedup (#143 Phase 2) skipped the poller's
    // re-delivered attempt entirely.
    const afterPollerReplay = await db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.tenantId, TENANT),
          eq(automationExecutions.ruleId, notifyRuleId),
          eq(automationExecutions.transitionEventId, doneTransitionEventId!),
        ),
      );
    expect(afterPollerReplay).toHaveLength(1);
    expect(afterPollerReplay[0]?.status).toBe("success");

    // The notify action's own side effect fired exactly once — proves the
    // dedup skip happened BEFORE the action ran, not just before a second
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
  }, 15_000);
});
