/**
 * SLA Scheduler — polls the outbox for `workflow.sla_scheduled` events and
 * enqueues a BullMQ delayed job for each one.
 *
 * The job ID is deterministic: `sla:{outboxEventId}`.  This lets the engine
 * locate and cancel a job by computing its ID from the outbox record, without
 * needing a separate lookup table.
 *
 * Cancellation path: when executeTransition fires, it marks the relevant
 * `workflow.sla_scheduled` outbox event as delivered (preventing scheduling).
 * If the job was already enqueued, the sla-breacher guards against firing by
 * checking the instance's current state before writing the breach event.
 *
 * Recovery after BullMQ downtime:
 * When the worker restarts after an outage, this scheduler re-polls the outbox
 * for any undelivered `workflow.sla_scheduled` events.  Events whose `fireAt`
 * is in the past (but within STALE_SLA_THRESHOLD_MS, default 48 h) are
 * enqueued with delay=0 so they fire immediately on recovery.  Events older
 * than the threshold are assumed unrecoverable: they are written to the
 * `dead_letter_events` table for operator inspection and marked delivered so
 * they are not retried.  The sla-breacher's late-firing warning
 * (LATE_WARNING_THRESHOLD_MS, 15 min) surfaces recoveries that may be
 * operationally significant without blocking the breach event.
 */

import { sql, inArray } from "drizzle-orm";
import { db, outboxEvents, deadLetterEvents } from "@platform/db";
import { logger } from "@platform/logger";
import { slaQueue } from "./queues.js";

export type SlaJobData = {
  outboxEventId: string;
  tenantId: string;
  instanceId: string;
  workflowId: string;
  stateName: string;
  slaHours: number;
  fireAt: string;
};

const BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * SLA events whose fireAt is more than 48 hours in the past are considered
 * unrecoverable.  They are dead-lettered instead of being enqueued, preventing
 * a flood of stale breach events on worker recovery after a prolonged outage.
 * Operators can inspect `dead_letter_events` to decide whether to re-trigger.
 */
export const STALE_SLA_THRESHOLD_MS = 48 * 60 * 60 * 1000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;

type SlaOutboxRow = {
  id: string;
  tenant_id: string;
  payload: {
    instanceId: string;
    workflowId: string;
    stateName: string;
    slaHours: number;
    fireAt: string;
  };
};

export async function tick(): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const rows = await tx.execute<SlaOutboxRow>(sql`
        SELECT id, tenant_id, payload
        FROM outbox_events
        WHERE delivered_at IS NULL
          AND event_type = 'workflow.sla_scheduled'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH_SIZE}
      `);

      if (rows.length === 0) return;

      const now = Date.now();
      const fresh: SlaOutboxRow[] = [];
      const stale: SlaOutboxRow[] = [];

      for (const row of rows) {
        const fireAt = new Date(row.payload.fireAt).getTime();
        if (Number.isNaN(fireAt)) {
          // Malformed fireAt — dead-letter immediately rather than enqueuing with
          // NaN delay (BullMQ treats NaN as delay=0, and NaN propagates into the
          // breacher's latency computation, triggering spurious late-warning logs).
          stale.push(row);
          continue;
        }
        const overdueMs = now - fireAt;
        if (overdueMs > STALE_SLA_THRESHOLD_MS) {
          stale.push(row);
        } else {
          fresh.push(row);
        }
      }

      // Dead-letter stale events — do not enqueue them.
      // Group by tenant and set app.tenant_id before each INSERT block.
      // dead_letter_events RLS derives its WITH CHECK from the USING clause:
      // tenant_id = current_setting('app.tenant_id', true)::uuid — without
      // the GUC the expression evaluates to NULL and every INSERT is silently
      // blocked.  set_config with true is SET LOCAL (transaction-scoped).
      if (stale.length > 0) {
        const staleByTenant = new Map<string, SlaOutboxRow[]>();
        for (const row of stale) {
          const group = staleByTenant.get(row.tenant_id) ?? [];
          group.push(row);
          staleByTenant.set(row.tenant_id, group);
        }

        for (const [tenantId, tenantRows] of staleByTenant) {
          await tx.execute(
            sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
          );
          await tx.insert(deadLetterEvents).values(
            tenantRows.map((row) => ({
              tenantId: row.tenant_id,
              originalEventId: row.id,
              eventType: "workflow.sla_scheduled" as const,
              payload: row.payload as Record<string, unknown>,
              ruleId: null,
              error: `SLA event exceeded stale threshold (${STALE_SLA_THRESHOLD_MS / 3_600_000}h). fireAt=${row.payload.fireAt}`,
              attemptCount: 1,
            })),
          );
        }

        logger.warn(
          {
            count: stale.length,
            thresholdHours: STALE_SLA_THRESHOLD_MS / 3_600_000,
            outboxEventIds: stale.map((r) => r.id),
          },
          "SLA scheduler: dead-lettered stale events",
        );
      }

      // Enqueue fresh events (delay=0 for past-due, positive delay for future)
      if (fresh.length > 0) {
        await Promise.all(
          fresh.map((row) => {
            const fireAt = new Date(row.payload.fireAt).getTime();
            const delay = Math.max(0, fireAt - now);
            const jobId = `sla:${row.id}`;

            return slaQueue.add(
              "sla.breach",
              {
                outboxEventId: row.id,
                tenantId: row.tenant_id,
                instanceId: row.payload.instanceId,
                workflowId: row.payload.workflowId,
                stateName: row.payload.stateName,
                slaHours: row.payload.slaHours,
                fireAt: row.payload.fireAt,
              } satisfies SlaJobData,
              { jobId, delay },
            );
          }),
        );

        logger.info(
          { count: fresh.length },
          "SLA scheduler: enqueued breach jobs",
        );
      }

      // Mark all rows (fresh + stale) as delivered so they are not re-processed
      await tx
        .update(outboxEvents)
        .set({ deliveredAt: new Date() })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((r) => r.id),
          ),
        );
    });
  } catch (err) {
    logger.error({ err }, "SLA scheduler tick failed");
  }
}

export function startSlaScheduler(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
  if (pollTimer) return;

  // Run the first tick immediately so stale events are processed on startup
  // without waiting up to intervalMs (10 s) — important for BullMQ recovery.
  activeTick = tick().finally(() => {
    activeTick = null;
  });

  pollTimer = setInterval(() => {
    // Skip this interval if the previous tick is still running.  Without this
    // guard a tick that takes longer than intervalMs would cause a second tick
    // to overwrite activeTick — stopSlaScheduler would then await the newer
    // promise and return while the original tick is still mid-transaction.
    if (activeTick) return;
    activeTick = tick().finally(() => {
      activeTick = null;
    });
  }, intervalMs);

  logger.info({ intervalMs }, "SLA scheduler started");
}

export async function stopSlaScheduler(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  logger.info({}, "SLA scheduler stopped");
}
