/**
 * Temporal scheduler tick — docs/specs/temporal-scheduler.md T9-T14,
 * docs/temporal-scheduler-design.md §3. Polls due `schedule_rules` across all
 * tenants (system-level, no tenant_id filter — same convention as
 * sla-scheduler.ts's cross-tenant outbox sweep), atomically claims each due
 * rule (SELECT FOR UPDATE SKIP LOCKED, advancing next_fire_at in the same
 * transaction), creates one ticket per fire, and records the outcome.
 *
 * Exactly-once across concurrent/rolling-deploy worker instances: the row
 * lock in claimRule is held from SELECT through the next_fire_at UPDATE and
 * released on commit — a second worker's SELECT ... FOR UPDATE SKIP LOCKED
 * against the same row either sees it locked (concurrent instance, skips)
 * or sees next_fire_at already advanced past `now` (sequential instance,
 * the inner WHERE re-check returns 0 rows).
 */

import { and, eq, isNull, lte } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  db,
  withTenantContext,
  scheduleRules,
  scheduleExecutions,
} from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import type { EntityError, ValidationError } from "@platform/entity-engine";
import {
  computeNextFireAt,
  buildTemplateVariables,
  renderTemplate,
  validateScheduleRuleRefs,
  type Template,
} from "@platform/scheduler";
import { writeAuditEntry } from "@platform/audit";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import {
  scheduleTickTotal,
  scheduleExecutionTotal,
  scheduleCatchUpTotal,
} from "@platform/telemetry";

type ScheduleRuleRow = typeof scheduleRules.$inferSelect;

const TICK_INTERVAL_MS = env.SCHEDULE_TICK_INTERVAL_SECONDS * 1000;
const CATCH_UP_MAX = env.SCHEDULE_CATCH_UP_MAX;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;

class ScheduleTemplateValidationError extends Error {
  constructor(public readonly fields: { field: string; message: string }[]) {
    super("Template failed fire-time re-validation");
    this.name = "ScheduleTemplateValidationError";
  }
}

// Name-string checks rather than instanceof — same convention as apps/api's
// handle-entity-error.ts, which avoids relying on instanceof holding across
// package/module boundaries.
function isEntityError(err: unknown): err is EntityError {
  return err instanceof Error && err.name === "EntityError";
}
function isValidationError(err: unknown): err is ValidationError {
  return err instanceof Error && err.name === "ValidationError";
}

/** Never stores raw err.message — a stable, small error_code vocabulary only. */
function classifyScheduleError(err: unknown): string {
  if (err instanceof ScheduleTemplateValidationError) {
    return "TEMPLATE_VALIDATION_FAILED";
  }
  if (isEntityError(err)) return err.code;
  if (isValidationError(err)) return "FIELD_VALIDATION_FAILED";
  return "INTERNAL_ERROR";
}

/**
 * Fire-time re-validation safety net (T9, design §3.1's `validateTemplate`
 * call before createEntity): the entityType/workflow/team/service/assignee
 * references were valid when the rule was created, but any of them may have
 * been deleted or moved tenants since — createEntity's own field validation
 * catches entity-type-schema drift, but not cross-tenant reference rot,
 * which is what packages/scheduler's validateScheduleRuleRefs re-checks.
 */
async function validateTemplate(
  tx: DbOrTx,
  rule: ScheduleRuleRow,
): Promise<void> {
  const template = rule.template as Template;
  const errors = await validateScheduleRuleRefs(tx, rule.tenantId, {
    entityTypeId: rule.entityTypeId,
    workflowId: rule.workflowId ?? undefined,
    template: {
      team_id: template.team_id,
      service_id: template.service_id,
      assignee_id: template.assignee_id,
    },
  });
  if (errors.length > 0) {
    throw new ScheduleTemplateValidationError(errors);
  }
}

/**
 * Enumerates every missed cron fire strictly after `afterExclusive` and
 * strictly before `beforeExclusive`, in chronological order. If `now` falls
 * exactly on a cron slot that slot belongs to the tick's normal fire, not
 * catch-up (design §3.5's comment) — computeNextFireAt's "strictly after"
 * semantics naturally exclude it since `before` is passed as `now` here.
 */
function getMissedFires(
  cronExpr: string,
  timezone: string,
  afterExclusive: Date,
  beforeExclusive: Date,
): Date[] {
  const fires: Date[] = [];
  let cursor = afterExclusive;
  for (;;) {
    const next = computeNextFireAt(cronExpr, timezone, cursor);
    if (next.getTime() >= beforeExclusive.getTime()) break;
    fires.push(next);
    cursor = next;
  }
  return fires;
}

/**
 * Atomically claims a due rule: re-checks it's still due under a row lock,
 * then advances next_fire_at, all in one transaction. Returns the
 * pre-advance row (so the caller still has the original scheduled time) or
 * null if another worker instance already claimed it.
 */
async function claimRule(
  rule: ScheduleRuleRow,
  tickTime: Date,
): Promise<ScheduleRuleRow | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(scheduleRules)
      .where(
        and(
          eq(scheduleRules.id, rule.id),
          eq(scheduleRules.status, "active"),
          lte(scheduleRules.nextFireAt, tickTime),
          // Belt-and-suspenders (Vijit review, M1): the outer poll already
          // filters isNull(deletedAt), and today's only soft-delete path
          // also sets status: "paused" -- but that's a load-bearing
          // invariant, not something this claim query should trust blindly.
          isNull(scheduleRules.deletedAt),
        ),
      )
      .for("update", { skipLocked: true })
      .limit(1);

    const claimedRow = rows[0];
    if (!claimedRow) return null;

    const nextFireAt = computeNextFireAt(
      rule.cronExpr,
      rule.timezone,
      tickTime,
    );
    await tx
      .update(scheduleRules)
      .set({ nextFireAt, lastFiredAt: tickTime, updatedAt: tickTime })
      .where(
        and(
          eq(scheduleRules.id, rule.id),
          eq(scheduleRules.tenantId, rule.tenantId),
        ),
      );

    return claimedRow;
  });
}

/**
 * Creates one ticket for a single scheduled fire. Does NOT touch
 * schedule_rules.next_fire_at — claimRule already advanced it once per due
 * rule per tick; catch-up fires reuse this same function for each missed
 * slot without re-advancing anything.
 */
async function fireRule(
  rule: ScheduleRuleRow,
  scheduledAt: Date,
  tickTime: Date,
): Promise<void> {
  try {
    await withTenantContext(rule.tenantId, async (tx) => {
      await validateTemplate(tx, rule);

      const vars = buildTemplateVariables(
        scheduledAt,
        rule.timezone,
        rule.name,
      );
      const rendered = renderTemplate(rule.template as Template, vars);

      const instance = await createEntity(tx, rule.tenantId, {
        entityTypeId: rule.entityTypeId,
        workflowId: rule.workflowId ?? undefined,
        assignedTo: rendered.assignee_id,
        createdBy: rule.createdBy,
        fields: {
          ...rendered.fields,
          title: rendered.title,
          ...(rendered.description
            ? { description: rendered.description }
            : {}),
          ...(rendered.severity ? { severity: rendered.severity } : {}),
          ...(rendered.team_id ? { team_id: rendered.team_id } : {}),
          ...(rendered.service_id ? { service_id: rendered.service_id } : {}),
        },
      });

      await tx.insert(scheduleExecutions).values({
        tenantId: rule.tenantId,
        ruleId: rule.id,
        scheduledAt,
        firedAt: tickTime,
        status: "success",
        entityInstanceId: instance.id,
      });

      await writeAuditEntry(tx, {
        tenantId: rule.tenantId,
        actorId: "system",
        actorType: "system",
        resourceType: "ticket",
        resourceId: instance.id,
        action: "schedule.ticket_created",
        metadata: { ruleId: rule.id, scheduledAt: scheduledAt.toISOString() },
      });

      logger.info(
        {
          tenantId: rule.tenantId,
          ruleId: rule.id,
          ticketId: instance.id,
          scheduledAt,
        },
        "schedule rule fired",
      );
    });
    scheduleExecutionTotal.add(1, { status: "success" });
  } catch (err: unknown) {
    const errorCode = classifyScheduleError(err);
    // Best-effort recording of the failure — guarded so that if THIS insert
    // itself throws (e.g. DB connection lost), the original `err` is still
    // the one re-thrown below, not masked by a secondary failure. Losing the
    // schedule_executions/audit row on a doubly-failed write is an accepted
    // trade-off; losing the original error's identity is not.
    try {
      await withTenantContext(rule.tenantId, async (tx) => {
        await tx.insert(scheduleExecutions).values({
          tenantId: rule.tenantId,
          ruleId: rule.id,
          scheduledAt,
          firedAt: tickTime,
          status: "failed",
          errorCode,
        });
        await writeAuditEntry(tx, {
          tenantId: rule.tenantId,
          actorId: "system",
          actorType: "system",
          resourceType: "schedule_rule",
          resourceId: rule.id,
          action: "schedule.execution_failed",
          metadata: { errorCode, scheduledAt: scheduledAt.toISOString() },
        });
      });
    } catch (recordErr: unknown) {
      logger.error(
        { recordErr, tenantId: rule.tenantId, ruleId: rule.id, errorCode },
        "schedule rule fire failed AND recording that failure also failed",
      );
    }
    scheduleExecutionTotal.add(1, { status: "failed", errorCode });
    logger.warn(
      { tenantId: rule.tenantId, ruleId: rule.id, errorCode, scheduledAt },
      "schedule rule fire failed",
    );
    throw err; // re-thrown so schedulerTick can count it; the tick loop does not rethrow further
  }
}

/**
 * Handles a rule whose original scheduled time is more than one tick cycle
 * old. `next_fire_at` was already advanced by claimRule. Returns the number
 * of missed fires skipped and failed (for the tick-level `skipped`/`failed`
 * counters) — `originalScheduledAt` itself is included as the first fire to
 * handle (it's the fire that made this rule due in the first place, not
 * merely a boundary marker for enumerating LATER missed fires); getMissedFires
 * only enumerates fires strictly between two points, so it's prepended here.
 */
async function handleCatchUp(
  rule: ScheduleRuleRow,
  originalScheduledAt: Date,
  now: Date,
): Promise<{ skipped: number; failed: number }> {
  const laterMissedFires = getMissedFires(
    rule.cronExpr,
    rule.timezone,
    originalScheduledAt,
    now,
  );
  const missedFires = [originalScheduledAt, ...laterMissedFires];

  const skipRecorded = async (scheduledAt: Date): Promise<void> => {
    await withTenantContext(rule.tenantId, async (tx) => {
      await tx.insert(scheduleExecutions).values({
        tenantId: rule.tenantId,
        ruleId: rule.id,
        scheduledAt,
        firedAt: now,
        status: "skipped",
      });
      await writeAuditEntry(tx, {
        tenantId: rule.tenantId,
        actorId: "system",
        actorType: "system",
        resourceType: "schedule_rule",
        resourceId: rule.id,
        action: "schedule.execution_skipped",
        metadata: { scheduledAt: scheduledAt.toISOString() },
      });
    });
    scheduleCatchUpTotal.add(1, { action: "skipped" });
  };

  if (!rule.catchUp) {
    // catch_up: false — skip everything; only log the most recent CATCH_UP_MAX
    // individually to bound DB writes on a long-down worker.
    const toLog = missedFires.slice(-CATCH_UP_MAX);
    const silentlyDropped = missedFires.length - toLog.length;
    for (const scheduledAt of toLog) {
      await skipRecorded(scheduledAt);
      logger.info(
        { tenantId: rule.tenantId, ruleId: rule.id, scheduledAt },
        "catch-up fire skipped (catch_up: false)",
      );
    }
    if (silentlyDropped > 0) {
      logger.info(
        { tenantId: rule.tenantId, ruleId: rule.id, silentlyDropped },
        "catch-up skip backlog over cap — oldest fires not individually logged",
      );
    }
    return { skipped: missedFires.length, failed: 0 };
  }

  // catch_up: true — execute the most recent CATCH_UP_MAX fires in
  // chronological order; anything older than the cap is logged as skipped.
  const toExecute = missedFires.slice(-CATCH_UP_MAX);
  const toSkip = missedFires.slice(0, missedFires.length - toExecute.length);

  for (const scheduledAt of toSkip) {
    await skipRecorded(scheduledAt);
    logger.info(
      { tenantId: rule.tenantId, ruleId: rule.id, scheduledAt },
      "catch-up fire skipped (over cap)",
    );
  }

  let executedFailed = 0;
  for (const scheduledAt of toExecute) {
    try {
      await fireRule(rule, scheduledAt, now);
      scheduleCatchUpTotal.add(1, { action: "executed" });
    } catch {
      // fireRule already logged/audited the failure; continue to the next
      // catch-up fire rather than aborting the remaining backlog. Counted
      // here (not just via scheduleExecutionTotal) so the tick-level
      // `failed` summary reflects catch-up failures too.
      executedFailed++;
    }
  }

  return { skipped: toSkip.length, failed: executedFailed };
}

export async function schedulerTick(
  tickIntervalMs = TICK_INTERVAL_MS,
): Promise<void> {
  const now = new Date();
  const tickStart = Date.now();
  let success = 0;
  let failed = 0;
  let skipped = 0;

  try {
    // System-level cross-tenant poll — intentionally no tenant_id filter;
    // the worker legitimately processes rules for every tenant in one pass.
    const dueRules = await db
      .select()
      .from(scheduleRules)
      .where(
        and(
          eq(scheduleRules.status, "active"),
          lte(scheduleRules.nextFireAt, now),
          isNull(scheduleRules.deletedAt),
        ),
      );

    for (const rule of dueRules) {
      const originalScheduledAt = rule.nextFireAt;
      if (!originalScheduledAt) continue; // defensive — nextFireAt is expected non-null for an active due rule

      const claimed = await claimRule(rule, now);
      if (!claimed) continue; // another worker instance already claimed this rule

      const isOverdue =
        originalScheduledAt.getTime() < now.getTime() - 2 * tickIntervalMs;

      if (isOverdue) {
        try {
          const result = await handleCatchUp(claimed, originalScheduledAt, now);
          skipped += result.skipped;
          failed += result.failed;
        } catch {
          failed++; // handleCatchUp's own fireRule calls already logged; continue to next rule
        }
      } else {
        try {
          await fireRule(claimed, originalScheduledAt, now);
          success++;
        } catch {
          failed++; // fireRule already logged/audited; continue to next rule
        }
      }
    }

    scheduleTickTotal.add(1, { outcome: "completed" });
    logger.info(
      {
        totalDue: dueRules.length,
        success,
        failed,
        skipped,
        durationMs: Date.now() - tickStart,
      },
      "scheduler tick complete",
    );
  } catch (err) {
    scheduleTickTotal.add(1, { outcome: "failed" });
    logger.error({ err }, "scheduler tick failed");
  }
}

export function startScheduleTickWorker(intervalMs = TICK_INTERVAL_MS): void {
  if (pollTimer) return;

  // intervalMs is threaded into schedulerTick itself (not just setInterval's
  // cadence) so isOverdue's 2x-multiplier overdue window always matches the
  // interval this instance actually ticks at, even when a caller overrides
  // the default (e.g. tests) — see review finding on this file.
  activeTick = schedulerTick(intervalMs).finally(() => {
    activeTick = null;
  });

  pollTimer = setInterval(() => {
    if (activeTick) return; // previous tick still running — skip this interval
    activeTick = schedulerTick(intervalMs).finally(() => {
      activeTick = null;
    });
  }, intervalMs);

  logger.info({ intervalMs }, "Schedule tick worker started");
}

export async function stopScheduleTickWorker(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  logger.info({}, "Schedule tick worker stopped");
}
