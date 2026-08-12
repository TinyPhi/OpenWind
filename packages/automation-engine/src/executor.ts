import { eq, and, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { DbOrTx } from "@platform/db";
import { automationRules, automationExecutions } from "@platform/db";
import { logger } from "@platform/logger";
import { env } from "@platform/config";
import { evaluateConditionTree } from "@platform/workflow-engine";
import type { ConditionTree } from "@platform/workflow-engine";
import { TriggerEventSchema } from "./event-schemas.js";
import type { TriggerEvent } from "./event-schemas.js";
import { AutomationError } from "./types.js";
import type { ActionConfig } from "./types.js";
import { executeNotifyAction } from "./actions/notify.js";
import { executeSetFieldAction } from "./actions/set-field.js";
import { executeTransitionAction } from "./actions/transition.js";
import { executeWebhookAction } from "./actions/webhook.js";
import { executeAssignAction } from "./actions/assign.js";
import { executeCreateEntityAction } from "./actions/create-entity.js";
import { executeCreateChildAction } from "./actions/create-child.js";
import { isOpen, recordFailure, reset } from "./circuit-breaker.js";

const MAX_DEPTH = 10;

export async function executeAutomationRules(
  db: DbOrTx,
  tenantId: string,
  rawEvent: unknown,
  depth = 0,
  redis?: Redis,
  outboxEventId?: string,
  // Identity of the workflow.transitioned event this fired from, threaded as
  // an explicit parameter (not read off `event`) so both the sync in-process
  // path (transition.ts, from executeTransition's return value) and the
  // async worker path (automation-worker.ts, from the outbox payload) agree
  // on the same value. When present, gates per-rule dedup (advisory lock +
  // status = 'success' check, below) so the same (ruleId, transitionEventId)
  // pair's action(s) never run twice — see
  // docs/specs/outbox-automation-idempotent-consumption.md.
  transitionEventId?: string,
): Promise<void> {
  if (depth >= MAX_DEPTH) {
    throw new AutomationError("MAX_DEPTH_EXCEEDED", { depth });
  }

  const parsed = TriggerEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    throw new AutomationError("INVALID_EVENT_PAYLOAD", {
      errors: parsed.error.issues,
    });
  }
  const event: TriggerEvent = parsed.data;

  const rules = await db
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.tenantId, tenantId),
        eq(automationRules.triggerType, event.eventType),
        eq(automationRules.isEnabled, true),
      ),
    )
    .orderBy(automationRules.priority, automationRules.createdAt);

  for (const rule of rules) {
    // Merge the event's top-level properties (e.g. toState, fromState,
    // assigneeId, slaHours) with any entity field values so that condition
    // trees can match on both. entity.created events carry a `fields` map;
    // all other event types carry their data as top-level properties only.
    // Excludes envelope/engine-internal keys (fields is merged in separately
    // below; version/tenantId/depth/transitionEventId are transport metadata,
    // not domain data — depth is an internal recursion counter and
    // transitionEventId an internal dedup identity, neither of which a
    // tenant should be able to write a condition against.
    const eventFields: Record<string, unknown> = {
      ...Object.fromEntries(
        Object.entries(event).filter(
          ([k]) =>
            ![
              "fields",
              "version",
              "tenantId",
              "depth",
              "transitionEventId",
            ].includes(k),
        ),
      ),
      ...("fields" in event ? (event.fields as Record<string, unknown>) : {}),
    };
    // Drizzle types jsonb as unknown; rowToRule in automation-crud does the
    // same cast after querying. Cast here too since executor queries directly.
    const passes = evaluateConditionTree(
      rule.conditions as ConditionTree | null,
      eventFields,
    );
    if (!passes) continue;

    // Inserts the running row, executes the rule's actions, and records the
    // final outcome. Unchanged in shape from before #143 Phase 2 — the only
    // difference is which `txDb` it's handed: the bare/ambient `db` when
    // there's no transitionEventId to dedup on (today's behavior, untouched),
    // or the advisory-lock-holding transaction below when there is one.
    const runRule = async (txDb: DbOrTx): Promise<void> => {
      const [execRow] = await txDb
        .insert(automationExecutions)
        .values({
          tenantId,
          ruleId: rule.id,
          triggerEvent: event as Record<string, unknown>,
          status: "running",
          startedAt: new Date(),
          transitionEventId: transitionEventId ?? null,
        })
        .returning();

      if (!execRow) return;

      // Run all actions for this rule inside txDb.transaction().
      // • When txDb is already a transaction (worker path via
      //   withTenantContext, or the dedup-lock transaction below): Drizzle
      //   creates a named savepoint automatically. If actions throw, the
      //   savepoint is rolled back but the outer transaction remains open so
      //   the audit-log update below can still execute.
      // • When txDb is a bare connection (direct callers, isolation tests):
      //   Drizzle starts a regular transaction. If actions throw, the
      //   transaction rolls back and the outer bare connection writes the
      //   audit log normally.
      //
      // NOTE: actions within a rule ARE atomically rolled back together on failure
      // because they all run inside this inner transaction/savepoint.  Partial
      // execution (actions 0..K-1 applied, action K fails) is therefore prevented
      // at the DB level.  Full saga / compensating-action support (for side-effects
      // that cannot be rolled back, e.g. sent emails) remains deferred.
      let actionError: Error | null = null;
      let skippedCount = 0;

      try {
        await txDb.transaction(async (ruleTx) => {
          for (const action of rule.actions as ActionConfig[]) {
            const skipped = await runAction(
              ruleTx,
              tenantId,
              rule.id,
              execRow.id,
              event,
              action,
              depth,
              redis,
              outboxEventId,
            );
            if (skipped) skippedCount++;
          }
        });
      } catch (err) {
        actionError = err instanceof Error ? err : new Error(String(err));
      }

      // Write the execution outcome using txDb (not the action-loop's inner
      // transaction) — always available regardless of whether that inner
      // transaction/savepoint was rolled back.
      const finalStatus = actionError
        ? "failed"
        : skippedCount > 0
          ? "degraded"
          : "success";

      await txDb
        .update(automationExecutions)
        .set({
          status: finalStatus,
          // If any actions were bypassed by the circuit breaker, record the count
          // so the audit trail reflects partial execution — not "success" (misleading)
          // nor "failed" (suggests a bug rather than a deliberate circuit-open skip).
          result:
            skippedCount > 0 && !actionError
              ? ({ skippedActions: skippedCount } as Record<string, unknown>)
              : null,
          error: actionError?.message ?? null,
          completedAt: new Date(),
        })
        .where(eq(automationExecutions.id, execRow.id));

      if (actionError) {
        logger.error(
          { tenantId, ruleId: rule.id, execId: execRow.id, err: actionError },
          "Automation: rule execution failed",
        );
      } else {
        logger.info(
          { tenantId, ruleId: rule.id, execId: execRow.id, skippedCount },
          skippedCount > 0
            ? "Automation: rule executed with degraded actions (circuit open)"
            : "Automation: rule executed successfully",
        );
      }
    };

    if (transitionEventId) {
      // Serialize concurrent attempts (sync in-process path vs. async
      // outbox->worker path, or two BullMQ retries) at the same (ruleId,
      // transitionEventId) pair on a Postgres advisory lock scoped to this
      // transaction — pg_advisory_xact_lock auto-releases on commit/rollback
      // of the enclosing REAL transaction (savepoints don't release it early,
      // which is what we want: a racing attempt blocks until this whole
      // dedup-check+insert+actions+status-update sequence has actually
      // committed, not just until this callback returns). See
      // docs/specs/outbox-automation-idempotent-consumption.md §I
      // (concurrency control) and §T (T4).
      await db.transaction(async (dedupTx) => {
        await dedupTx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${rule.id} || ':' || ${transitionEventId}, 0))`,
        );

        // Checked AFTER acquiring the lock, not before — a check-then-lock
        // order would let two concurrent attempts both pass the check before
        // either inserts anything. Only a status = 'success' row counts: a
        // prior 'failed'/'running' row for this pair must never block a
        // legitimate retry (see the partial unique index's WHERE clause,
        // packages/db/src/schema/automation-engine.ts).
        const [existingSuccess] = await dedupTx
          .select({ id: automationExecutions.id })
          .from(automationExecutions)
          .where(
            and(
              eq(automationExecutions.tenantId, tenantId),
              eq(automationExecutions.ruleId, rule.id),
              eq(automationExecutions.transitionEventId, transitionEventId),
              eq(automationExecutions.status, "success"),
            ),
          )
          .limit(1);

        if (existingSuccess) {
          logger.info(
            { tenantId, ruleId: rule.id, transitionEventId },
            "Automation: skipping rule — already completed for this transition",
          );
          return;
        }

        await runRule(dedupTx);
      });
    } else {
      await runRule(db);
    }
  }
}

/**
 * Runs a single action.
 * Returns `true` if the action was skipped because the circuit breaker is open;
 * `false` if the action executed (successfully or after throwing).
 * Throws if the underlying action handler throws.
 *
 * This switch is the shape contract every `automation_rules.actions` entry
 * must match — apps/api/src/routes/automation-rules/schemas.ts's
 * ActionConfigSchema validates API-created/updated rules against it, but
 * module seed SQL (e.g. modules/helpdesk/seed/003_automation_rules.sql)
 * writes `automation_rules` directly and bypasses that validation. A
 * mismatched shape doesn't error here — it just falls to `default` below and
 * silently does nothing. Check this switch by hand when adding a new seed's
 * automation rule.
 */
async function runAction(
  db: DbOrTx,
  tenantId: string,
  ruleId: string,
  execId: string,
  event: TriggerEvent,
  action: ActionConfig,
  depth: number,
  redis?: Redis,
  outboxEventId?: string,
): Promise<boolean> {
  if (!redis) {
    throw new AutomationError("CIRCUIT_BREAKER_UNAVAILABLE", {
      actionType: action.type,
    });
  }
  if (await isOpen(redis, tenantId, action.type)) {
    logger.warn(
      { tenantId, actionType: action.type },
      "Automation: circuit open — skipping action",
    );
    return true; // skipped
  }

  try {
    switch (action.type) {
      case "notify":
        await executeNotifyAction(
          db,
          tenantId,
          ruleId,
          execId,
          event,
          action.config,
          redis,
          outboxEventId,
        );
        break;
      case "set_field":
        await executeSetFieldAction(db, tenantId, event, action.config, depth);
        break;
      case "assign":
        await executeAssignAction(db, tenantId, event, action.config, depth);
        break;
      case "create_entity":
        await executeCreateEntityAction(
          db,
          tenantId,
          event,
          action.config,
          depth,
        );
        break;
      case "create_child":
        await executeCreateChildAction(
          db,
          tenantId,
          event,
          action.config,
          depth,
        );
        break;
      case "transition":
        await executeTransitionAction(
          db,
          tenantId,
          event,
          action.config,
          depth,
          redis,
          outboxEventId,
        );
        break;
      case "webhook":
        await executeWebhookAction(tenantId, ruleId, event, action.config, {
          extraBlockCidrs: env.SSRF_BLOCK_CIDRS,
        });
        break;
      case "connector.action":
        // Phase 3 stub — the type is valid and may be stored in automation_rules,
        // but the connector runtime isn't implemented yet. Log and skip rather
        // than throwing, so rules seeded today survive the Phase 3 cut-over
        // without hard-failing on every execution.
        logger.warn(
          { tenantId, ruleId },
          "Automation: connector.action is not yet implemented — skipping",
        );
        break;
      default:
        throw new AutomationError("UNKNOWN_ACTION_TYPE", {
          actionType: (action as { type: string }).type,
        });
    }
    await reset(redis, tenantId, action.type);
  } catch (err) {
    await recordFailure(redis, tenantId, action.type);
    throw err;
  }

  return false; // executed
}
