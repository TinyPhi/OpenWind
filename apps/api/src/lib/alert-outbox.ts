import { sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";

/**
 * Marks any still-undelivered `ticket.alert_scheduled` outbox rows for this
 * alert as delivered, WITHOUT enqueuing anything — a void, not a fire.
 *
 * Required before inserting a fresh outbox row on edit: BullMQ's queue.add()
 * with a jobId that's already scheduled is a silent no-op on the *existing*
 * job (verified directly against this stack's Redis — the second add() call
 * returns as if it succeeded but the original job's data/delay wins). If the
 * alert's original outbox row from creation hasn't been polled yet when an
 * edit lands, both rows would otherwise sit undelivered; whichever the
 * scheduler polls first (lowest created_at, i.e. the original) wins the
 * BullMQ schedule, silently discarding the edit's new fire time. Voiding the
 * old row here means the scheduler only ever sees the newest one. See
 * docs/specs/ticket-alerts.md and update-alert.ts.
 *
 * Also used for cancel/cascade-cancel hygiene — a cancelled alert's stale
 * outbox row is harmless (alert-worker's status guard no-ops it) but voiding
 * it here keeps it from sitting around and being logged as "enqueued" for a
 * job that will immediately no-op.
 */
export async function voidPendingAlertOutboxRows(
  tx: DbOrTx,
  alertId: string,
): Promise<void> {
  await tx.execute(sql`
    UPDATE outbox_events
    SET delivered_at = now()
    WHERE event_type = 'ticket.alert_scheduled'
      AND delivered_at IS NULL
      AND payload->>'alertId' = ${alertId}
  `);
}
