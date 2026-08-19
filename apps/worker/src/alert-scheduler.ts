/**
 * Alert Scheduler — polls the outbox for `ticket.alert_scheduled` events and
 * enqueues a BullMQ delayed job for each one.
 *
 * Deliberately independent of sla-scheduler.ts (docs/specs/ticket-alerts.md
 * §V) — separate file, separate queue (`ticket-alerts`, not `sla`), separate
 * poll loop. SLA timer latency/throughput must never depend on alert volume,
 * and vice versa.
 *
 * The job ID is deterministic: `alert-{alertId}` (see
 * apps/api/src/lib/ticket-alerts-queue.ts) — a dash, not a colon, since
 * BullMQ rejects custom job ids containing ":" ("Custom Id cannot contain :").
 * This lets the API cancel or reschedule a job by computing its ID from the
 * alert record, without a separate lookup table — same trick as
 * sla-scheduler.ts's `sla:{outboxEventId}` (which is itself latently broken
 * by this same colon restriction — pre-existing, out of scope here).
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
import { db, outboxEvents, setOutboxSweeperRole } from "@platform/db";
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
      // This sweep is deliberately cross-tenant, so it can't set
      // app.tenant_id — see setOutboxSweeperRole's doc comment.
      await setOutboxSweeperRole(tx);

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

      // Per-row isolation (allSettled, not all): one row's enqueue failure
      // must never poison the rest of the batch. An earlier version used
      // Promise.all + a single transaction-wide update, so a single bad row
      // (the colon-in-jobId incident, or any future transient failure) threw,
      // rolled back the whole transaction, and left every row in the batch —
      // including unrelated alerts — permanently undelivered, re-polled and
      // re-failing every tick forever.
      const enqueueResults = await Promise.allSettled(
        fresh.map(async (row) => {
          const fireAt = new Date(row.payload.fireAt).getTime();
          const delay = Math.max(0, fireAt - now);
          const jobId = `alert-${row.payload.alertId}`;

          await ticketAlertsQueue.add(
            "alert.fire",
            {
              alertId: row.payload.alertId,
              tenantId: row.tenant_id,
              fireAt: row.payload.fireAt,
            } satisfies AlertJobData,
            { jobId, delay },
          );
          return row.id;
        }),
      );

      const enqueuedIds: string[] = [];
      const failedRows: { row: AlertOutboxRow; err: unknown }[] = [];
      enqueueResults.forEach((result, i) => {
        const row = fresh[i];
        if (!row) return;
        if (result.status === "fulfilled") {
          enqueuedIds.push(result.value);
        } else {
          failedRows.push({ row, err: result.reason });
        }
      });

      if (enqueuedIds.length > 0) {
        logger.info(
          { count: enqueuedIds.length },
          "Alert scheduler: enqueued fire jobs",
        );
      }
      if (failedRows.length > 0) {
        logger.error(
          {
            count: failedRows.length,
            outboxEventIds: failedRows.map((f) => f.row.id),
            errs: failedRows.map((f) => String(f.err)),
          },
          "Alert scheduler: some rows failed to enqueue — left undelivered for retry next tick, rest of batch unaffected",
        );
      }

      // Mark delivered: stale rows + successfully-enqueued fresh rows only.
      // Failed rows are deliberately left delivered_at=NULL so the next
      // tick's FOR UPDATE SKIP LOCKED re-selects and retries just them.
      const deliveredIds = [...stale.map((r) => r.id), ...enqueuedIds];
      if (deliveredIds.length > 0) {
        await tx
          .update(outboxEvents)
          .set({ deliveredAt: new Date() })
          .where(inArray(outboxEvents.id, deliveredIds));
      }
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
