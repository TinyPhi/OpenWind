/**
 * #143 Phase 2, T4 — issue #382: proves `pg_advisory_xact_lock` in
 * executor.ts actually SERIALIZES two genuinely concurrent attempts at the
 * same (ruleId, transitionEventId), not just that the end state happens to
 * be correct after the fact.
 *
 * automation-transition-dedup-sync-async-race.isolation.test.ts (PR #380)
 * proves SEQUENTIAL dedup: one call runs to completion and commits, then a
 * second is fed the same transitionEventId and finds the existing 'success'
 * row. Its own docstring flagged that this does NOT exercise the advisory
 * lock's actual blocking behavior — two genuinely separate Postgres sessions
 * racing on `pg_advisory_xact_lock`, one blocked until the other commits.
 * This file is that missing test.
 *
 * Mechanism (see wrapForLockTiming below):
 *  - Both concurrent calls use the SAME shared `db` export (a postgres-js
 *    connection pool, DATABASE_POOL_MAX defaults to 10 — see
 *    packages/db/src/client.ts). Each independent `db.transaction(...)`
 *    call checks out its own physical connection from the pool, so two
 *    concurrent calls genuinely run on two separate Postgres backend
 *    sessions — exactly like the real sync-in-process-path vs.
 *    async-worker-path scenario this lock exists for. No second DB client
 *    or explicit connection management is needed to get real concurrency.
 *  - The FIRST call is handed a Proxy-wrapped `db` (`wrapForLockTiming`)
 *    that does two things without touching executor.ts at all:
 *      1. Detects the exact moment the advisory lock is acquired by
 *         intercepting the `dedupTx.execute(select pg_advisory_xact_lock(...))`
 *         call executor.ts makes (the only raw `.execute()` call in this
 *         code path) and signals a promise once it resolves.
 *      2. Injects a real `await new Promise(resolve => setTimeout(...))`
 *         delay immediately before the rule's action(s) run — i.e. right
 *         before the nested `dedupTx.transaction(ruleTx => ...)` callback
 *         that wraps the action loop inside `runRule()` — while the outer
 *         dedup transaction, and the advisory lock it holds, is still open.
 *  - The test does not start the SECOND call until the first call's lock
 *    acquisition has been signaled. This isn't a hack to dodge concurrency —
 *    it removes a different, uninteresting source of flakiness (which of
 *    the two attempts happens to reach `pg_advisory_xact_lock` first is
 *    scheduler-dependent and not what this test is about). Once started,
 *    the second call's own `pg_advisory_xact_lock` call genuinely blocks at
 *    the Postgres level — a real wait, not a simulated one — until the
 *    first call's transaction commits, releasing the lock.
 *  - The second call's wall-clock duration (measured from just after it was
 *    allowed to start) is asserted to be at least ~80% of the injected
 *    delay — proof the lock actually blocked it, not that the two calls
 *    coincidentally ran in a safe order.
 *
 * The observable side effect is a `notify` action. Deliberately NOT passing
 * an `outboxEventId` to either call so notify's own idempotency key
 * (deriveNotificationId, notify.ts) falls back to each attempt's own
 * `execId` rather than a shared value — this means if the advisory lock had
 * a bug and let both attempts through, notify's own dedup could not
 * accidentally mask that bug behind a single notification row (mirrors the
 * precaution documented in automation-transition-dedup-sync-async-race's
 * docstring).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import Redis from "ioredis";
import type { DbOrTx } from "@platform/db";
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
} from "@platform/automation-engine";

const TENANT = "ffffffff-0000-4000-f000-000000000382";
const RECIPIENT = "u-t382-concurrent-lock-recipient";
const DELAY_MS = 400;

let entityType: EntityType;
let workflowId: string;
let openToProcessingId: string;
let notifyRuleId: string;
let redis: Redis;

/**
 * Wraps a Drizzle db/transaction object so the object handed to
 * executeAutomationRules can (a) observe the exact moment the advisory
 * lock is acquired and (b) inject a real delay immediately before the
 * rule's actions run, without any change to executor.ts. Only intercepts
 * "execute" and "transaction" — everything else passes straight through to
 * the real object (bound, so internal `this` references stay correct).
 *
 * `depth` tracks how many `.transaction()` calls deep we are relative to
 * the top-level object passed into executeAutomationRules:
 *   depth 0 = the `db` argument itself → its `.transaction()` call is
 *             executor.ts's `db.transaction(dedupTx => ...)` (T4's dedup
 *             transaction, entered BEFORE the lock is acquired).
 *   depth 1 = the resulting `dedupTx` → its `.transaction()` call is
 *             `runRule()`'s `txDb.transaction(ruleTx => ...)`, which wraps
 *             the action loop — exactly where the delay belongs, since the
 *             lock is already held by the time this fires.
 */
function wrapForLockTiming(
  real: DbOrTx,
  opts: { delayMs: number; onLockAcquired: () => void },
  depth = 0,
): DbOrTx {
  return new Proxy(real as object, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop === "execute" && typeof value === "function") {
        return async (...args: unknown[]) => {
          // The only raw .execute() call anywhere in this path is
          // executor.ts's `select pg_advisory_xact_lock(...)` — by the
          // time this resolves, the lock is genuinely held on this session.
          const fn = value as (...a: unknown[]) => Promise<unknown>;
          const result = await fn.apply(target, args);
          opts.onLockAcquired();
          return result;
        };
      }
      if (prop === "transaction" && typeof value === "function") {
        const fn = value as (
          cb: (tx: unknown) => Promise<unknown>,
        ) => Promise<unknown>;
        return (cb: (tx: unknown) => Promise<unknown>) =>
          fn.call(target, async (innerTx: unknown) => {
            if (depth === 1) {
              await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
            }
            // innerTx is the real Drizzle tx object returned by the real
            // .transaction() call — recursing keeps the same instrumentation
            // available at the next nesting level (depth + 1).
            return cb(wrapForLockTiming(innerTx as DbOrTx, opts, depth + 1));
          });
      }
      // Bind so methods keep the correct `this` (the real underlying
      // object) when invoked off the proxy.
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as DbOrTx;
}

beforeAll(async () => {
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  // Required by notifications.tenant_id's FK.
  await db.insert(tenants).values({
    id: TENANT,
    name: "T382 concurrent lock test",
    slug: `t382-concurrent-lock-${TENANT}`,
  });
  entityType = await createEntityType(db, TENANT, {
    name: `t382_lock_ticket_${Date.now()}`,
    plural: "t382_lock_tickets",
    allowCustomFields: true,
  });

  const workflow = await createWorkflow(db, TENANT, "test-actor", {
    entityTypeId: entityType.id,
    name: `t382_lock_workflow_${Date.now()}`,
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

  const notifyRule = await createAutomationRule(db, TENANT, {
    name: "T382 notify on processing",
    triggerType: "workflow.transitioned",
    triggerConfig: {},
    conditions: { op: "eq", field: "toState", value: "processing" },
    actions: [
      {
        type: "notify",
        config: { recipientId: RECIPIENT, payload: { title: "Processing" } },
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

describe("executor.ts's advisory lock genuinely serializes two concurrent attempts at the same (ruleId, transitionEventId) (#382)", () => {
  it("blocks the second concurrent call until the first (delayed) call commits, then finds the lock unnecessary — one success row, one notification", async () => {
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

    let resolveLockAcquired: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      resolveLockAcquired = resolve;
    });

    // Call 1: delayed. Holds the advisory lock for at least DELAY_MS before
    // its action runs and it commits.
    const call1Start = Date.now();
    const call1 = executeAutomationRules(
      wrapForLockTiming(db, {
        delayMs: DELAY_MS,
        onLockAcquired: () => resolveLockAcquired(),
      }),
      TENANT,
      row?.payload,
      0,
      redis,
      undefined,
      transitionEventId,
    ).then(() => Date.now() - call1Start);

    // Don't start call 2 until call 1 has genuinely acquired the advisory
    // lock — see the file docstring for why this removes an uninteresting
    // race (scheduler ordering) without weakening the actual thing under
    // test (call 2's own lock acquisition genuinely blocking on Postgres).
    await lockAcquired;

    // Call 2: plain `db`, no delay. Its own attempt to acquire the SAME
    // advisory lock (same ruleId + transitionEventId) must now genuinely
    // block at the Postgres level until call 1 commits.
    const call2Start = Date.now();
    const call2 = executeAutomationRules(
      db,
      TENANT,
      row?.payload,
      0,
      redis,
      undefined,
      transitionEventId,
    ).then(() => Date.now() - call2Start);

    const [duration1, duration2] = await Promise.all([call1, call2]);

    // AC1/AC2: duration1 trivially includes the injected delay (it's the
    // one sleeping); duration2 is the real proof — it was only allowed to
    // start AFTER call 1 held the lock, so if it still took at least ~80%
    // of the injected delay, that time was spent genuinely blocked waiting
    // for call 1 to commit, not processing anything of its own (its own
    // work — one SELECT for rules, one advisory-lock attempt, one
    // existing-success check — is sub-millisecond next to DELAY_MS).
    expect(duration1).toBeGreaterThanOrEqual(DELAY_MS);
    expect(duration2).toBeGreaterThanOrEqual(DELAY_MS * 0.8);

    // AC3: exactly one success row for this (ruleId, transitionEventId) —
    // call 2 found it already there after waiting out the lock and skipped.
    const executions = await db
      .select()
      .from(automationExecutions)
      .where(
        and(
          eq(automationExecutions.tenantId, TENANT),
          eq(automationExecutions.ruleId, notifyRuleId),
          eq(automationExecutions.transitionEventId, transitionEventId),
        ),
      );
    expect(executions).toHaveLength(1);
    expect(executions[0]?.status).toBe("success");

    // And the notify action's side effect fired exactly once — not masked
    // by notify's own idempotency (no shared outboxEventId was passed), so
    // this is a genuine count of how many times the action ran.
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
