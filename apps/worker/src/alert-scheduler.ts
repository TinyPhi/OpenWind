/**
 * Alert Scheduler — polls the outbox for `ticket.alert_scheduled` events and
 * enqueues a BullMQ delayed job for each one.
 *
 * Deliberately independent of sla-scheduler.ts (docs/specs/ticket-alerts.md
 * §V) — separate file, separate queue (`ticket-alerts`, not `sla`), separate
 * poll loop. SLA timer latency/throughput must never depend on alert volume,
 * and vice versa.
 *
 * The job ID is deterministic: `alert:{alertId}` (see
 * apps/api/src/lib/ticket-alerts-queue.ts). This lets the API cancel or
 * reschedule a job by computing its ID from the alert record, without a
 * separate lookup table — same trick as sla-scheduler.ts's `sla:{outboxEventId}`.
 *
 * Recovery after BullMQ downtime: on restart this scheduler re-polls the
 * outbox for undelivered `ticket.alert_scheduled` events. Events whose
 * fireAt is in the past (but within STALE_ALERT_THRESHOLD_MS) are enqueued
 * with delay=0 so they fire immediately on recovery. There is no dead-letter
 * path here — unlike SLA breaches, a personal reminder firing a bit late
 * (or, past the threshold, not automatically firing at all — the row simply
 * stays `pending` for the user to notice and re-set) is not an operational
 * incident worth paging over; alert-worker.ts's status guard still fires it
 * at delay=0 if within threshold.
 */

import { sql, inArray } from "drizzle-orm";
import { db, outboxEvents } from "@platform/db";
import { logger } from "@platform/logger";
import { ticketAlertsQueue } from "./queues.js";

export type AlertJobData = {
  alertId: string;
  tenantId: string;
  fireAt: string;
};

const BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * Alert events whose fireAt is more than 48 hours in the past are considered
 * unrecoverable — enqueuing them now would surprise the recipient with a
 * wildly late reminder. They are left `pending` in ticket_alerts (visible to
 * the creator, who can re-set it) rather than force-fired or dead-lettered.
 */
export const STALE_ALERT_THRESHOLD_MS = 48 * 60 * 60 * 1000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;

type AlertOutboxRow = {
  id: string;
  tenant_id: string;
  payload: {
    alertId: string;
    fireAt: string;
  };
};

export async function tick(): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const rows = await tx.execute<AlertOutboxRow>(sql`
        SELECT id, tenant_id, payload
        FROM outbox_events
        WHERE delivered_at IS NULL
          AND event_type = 'ticket.alert_scheduled'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH_SIZE}
      `);

      if (rows.length === 0) return;

      const now = Date.now();
      const fresh: AlertOutboxRow[] = [];
      const stale: AlertOutboxRow[] = [];

      for (const row of rows) {
        const fireAt = new Date(row.payload.fireAt).getTime();
        if (Number.isNaN(fireAt)) {
          stale.push(row);
          continue;
        }
        const overdueMs = now - fireAt;
        if (overdueMs > STALE_ALERT_THRESHOLD_MS) {
          stale.push(row);
        } else {
          fresh.push(row);
        }
      }

      if (stale.length > 0) {
        logger.warn(
          {
            count: stale.length,
            thresholdHours: STALE_ALERT_THRESHOLD_MS / 3_600_000,
            outboxEventIds: stale.map((r) => r.id),
          },
          "Alert scheduler: skipped stale events (left pending, not enqueued)",
        );
      }

      if (fresh.length > 0) {
        await Promise.all(
          fresh.map((row) => {
            const fireAt = new Date(row.payload.fireAt).getTime();
            const delay = Math.max(0, fireAt - now);
            const jobId = `alert:${row.payload.alertId}`;

            return ticketAlertsQueue.add(
              "alert.fire",
              {
                alertId: row.payload.alertId,
                tenantId: row.tenant_id,
                fireAt: row.payload.fireAt,
              } satisfies AlertJobData,
              { jobId, delay },
            );
          }),
        );

        logger.info(
          { count: fresh.length },
          "Alert scheduler: enqueued fire jobs",
        );
      }

      // Mark all rows (fresh + stale) as delivered so they are not re-processed.
      // Stale rows are marked delivered even though they weren't enqueued —
      // the ticket_alerts row itself (still 'pending') is the durable record,
      // not the outbox row.
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
    logger.error({ err }, "Alert scheduler tick failed");
  }
}

export function startAlertScheduler(
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
): void {
  if (pollTimer) return;

  activeTick = tick().finally(() => {
    activeTick = null;
  });

  pollTimer = setInterval(() => {
    if (activeTick) return;
    activeTick = tick().finally(() => {
      activeTick = null;
    });
  }, intervalMs);

  logger.info({ intervalMs }, "Alert scheduler started");
}

export async function stopAlertScheduler(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  logger.info({}, "Alert scheduler stopped");
}
