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
  postScheduleRemarkComment,
  TemplateSchema,
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
 *
 * Also re-parses the stored template against TemplateSchema (Vijit review,
 * G3): the tick path previously only ever went through `as Template`, a
 * type assertion with no runtime check, so a row written by a migration,
 * a direct DB write, or a row created before a schema tightening (e.g.
 * M3's assignee_id .uuid()) reached renderTemplate/createEntity with no
 * shape validation at all. Returns the parsed template so callers use the
 * validated shape rather than re-asserting it themselves.
 */
async function validateTemplate(
  tx: DbOrTx,
  rule: ScheduleRuleRow,
): Promise<Template> {
  const parsed = TemplateSchema.safeParse(rule.template);
  if (!parsed.success) {
    throw new ScheduleTemplateValidationError(
      parsed.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  const template = parsed.data;
  const errors = await validateScheduleRuleRefs(tx, rule.tenantId, {
    entityTypeId: rule.entityTypeId,
    workflowId: rule.workflowId ?? undefined,
    template: {
      teamId: template.teamId,
      service_id: template.service_id,
      assignedTo: template.assignedTo,
    },
  });
  if (errors.length > 0) {
    throw new ScheduleTemplateValidationError(errors);
  }
  return template;
}

/**
 * Enumerates missed cron fires strictly after `afterExclusive` and strictly
 * before `beforeExclusive`, in chronological order. If `now` falls exactly
 * on a cron slot that slot belongs to the tick's normal fire, not catch-up
 * (design §3.5's comment) — computeNextFireAt's "strictly after" semantics
 * naturally exclude it since `before` is passed as `now` here.
 *
 * Bounded to a sliding window of the last `maxFires` entries (Vijit review,
 * G1): without this, a per-minute rule left unfired for e.g. a 30-day
 * outage would build a ~43,200-element array just to have the caller slice
 * it down to CATCH_UP_MAX afterward. A window (drop the oldest as new fires
 * are found), not an early break, is required here — the caller always
 * wants the MOST RECENT `maxFires` fires (both `catch_up: true`'s execute
 * set and `catch_up: false`'s individually-logged set take the tail via
 * `.slice(-CATCH_UP_MAX)`); breaking out as soon as `maxFires` is reached
 * would instead keep the EARLIEST ones, silently reversing which fires get
 * executed/logged vs. dropped. `totalCount` is tracked separately so the
 * true total (for `skipped`/`silentlyDropped` accounting) survives even
 * though old entries are evicted from the window.
 */
function getMissedFires(
  cronExpr: string,
  timezone: string,
  afterExclusive: Date,
  beforeExclusive: Date,
  maxFires: number,
): { recentFires: Date[]; totalCount: number } {
  const recentFires: Date[] = [];
  let totalCount = 0;
  let cursor = afterExclusive;
  for (;;) {
    const next = computeNextFireAt(cronExpr, timezone, cursor);
    if (next.getTime() >= beforeExclusive.getTime()) break;
    totalCount++;
    recentFires.push(next);
    if (recentFires.length > maxFires) recentFires.shift();
    cursor = next;
  }
  return { recentFires, totalCount };
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
          // Explicit tenant filter (Vijit review, G2): this transaction
          // isn't wrapped in withTenantContext (RLS is inactive here), and
          // the UPDATE below already carries this filter -- the asymmetry
          // was a future-reader trap even though UUID uniqueness makes an
          // actual cross-tenant collision effectively impossible.
          eq(scheduleRules.tenantId, rule.tenantId),
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
    const { instance, remark } = await withTenantContext(
      rule.tenantId,
      async (tx) => {
        const template = await validateTemplate(tx, rule);

        const vars = buildTemplateVariables(
          scheduledAt,
          rule.timezone,
          rule.name,
        );
        const rendered = renderTemplate(template, vars);

        // due_days is an offset from THIS fire's own scheduled instant, not
        // tickTime (docs/specs/schedule-rules-mandate-fields.md R4) --
        // scheduledAt is the canonical fire time even for a catch-up run
        // executed late.
        const dueDate = new Date(
          scheduledAt.getTime() + rendered.due_days * 24 * 60 * 60 * 1000,
        ).toISOString();

        // Exactly one of assignedTo/teamId (TemplateSchema's superRefine
        // guarantees this) -- teamId mode leaves assignment unset here and
        // instead writes fields.team_id, the same JSONB slot the existing
        // entity.created -> resolve_oncall automation rule already reads,
        // so a rule-created ticket resolves via the identical cascade a
        // manually created team-assigned ticket does (R2). No separate
        // resolution logic for scheduled tickets.
        const instance = await createEntity(tx, rule.tenantId, {
          entityTypeId: rule.entityTypeId,
          workflowId: rule.workflowId ?? undefined,
          assignedTo: rendered.assignedTo,
          dueDate,
          createdBy: rule.createdBy,
          fields: {
            ...rendered.fields,
            title: rendered.title,
            ...(rendered.description
              ? { description: rendered.description }
              : {}),
            ...(rendered.severity ? { severity: rendered.severity } : {}),
            ...(rendered.teamId ? { team_id: rendered.teamId } : {}),
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
          metadata: {
            ruleId: rule.id,
            scheduledAt: scheduledAt.toISOString(),
          },
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

        return { instance, remark: rendered.remark };
      },
    );

    // Best-effort, outside the create transaction (already committed) --
    // a remark-post failure must never fail the fire (R5); mirrors
    // apps/api/src/routes/entities/create.ts's own postRemarkComment call.
    if (instance.workflowId) {
      try {
        await withTenantContext(rule.tenantId, (tx) =>
          postScheduleRemarkComment(tx, {
            tenantId: rule.tenantId,
            instanceId: instance.id,
            workflowId: instance.workflowId as string,
            currentState: instance.currentState,
            actorId: rule.createdBy,
            text: remark,
          }),
        );
      } catch (remarkErr) {
        logger.warn(
          { remarkErr, tenantId: rule.tenantId, ticketId: instance.id },
          "schedule rule fired: failed to post remark as first comment",
        );
      }
    }
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
  const { recentFires, totalCount: laterCount } = getMissedFires(
    rule.cronExpr,
    rule.timezone,
    originalScheduledAt,
    now,
    CATCH_UP_MAX,
  );
  // recentFires is already windowed to the last CATCH_UP_MAX later fires;
  // prepending originalScheduledAt can push this to CATCH_UP_MAX + 1, so the
  // final .slice(-CATCH_UP_MAX) below still trims to exactly the cap.
  const missedFires = [originalScheduledAt, ...recentFires].slice(
    -CATCH_UP_MAX,
  );
  const totalMissed = laterCount + 1;

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
    // individually to bound DB writes on a long-down worker. missedFires is
    // already windowed to at most CATCH_UP_MAX entries (see getMissedFires),
    // so silentlyDropped is computed against totalMissed, the true count.
    const silentlyDropped = totalMissed - missedFires.length;
    for (const scheduledAt of missedFires) {
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
    return { skipped: totalMissed, failed: 0 };
  }

  // catch_up: true — execute the most recent CATCH_UP_MAX fires in
  // chronological order. Anything older than the cap was never retained by
  // getMissedFires's bounded window (G1), so it can't be individually
  // recorded per-date here; logged as a single aggregate count instead of
  // per-date skip rows, same convention as the catch_up: false branch above.
  const skippedOverCap = totalMissed - missedFires.length;
  if (skippedOverCap > 0) {
    logger.info(
      { tenantId: rule.tenantId, ruleId: rule.id, skippedOverCap },
      "catch-up execute backlog over cap — oldest fires skipped without individual audit rows",
    );
  }

  let executedFailed = 0;
  for (const scheduledAt of missedFires) {
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

  return { skipped: skippedOverCap, failed: executedFailed };
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
