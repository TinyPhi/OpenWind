import { sql, inArray } from "drizzle-orm";
import { db, outboxEvents, setOutboxSweeperRole } from "@platform/db";
import { logger } from "@platform/logger";
import { notifyQueue } from "./queues.js";

const BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

// The 8 trigger types the in-app notification hub cares about
// (docs/specs/in-app-notification-hub.md), plus the 3 ticket-room-only event
// types added for docs/specs/ticket-live-updates.md — these 3 have no inbox
// notification recipients of their own (resolveRecipients' default case
// returns []), but still need to reach notification-worker.ts so it can fire
// the room-scoped live push. Positive allowlist, matching outbox-poller.ts's
// own convention — a new outbox event type is excluded by default rather
// than silently claimed and mishandled.
const NOTIFICATION_EVENT_TYPES = [
  "entity.assigned",
  "entity.unassigned",
  "entity.updated",
  "comment.mentioned",
  "comment.mention_access_granted",
  "comment.replied",
  "access.granted",
  "access.revoked",
  "access.updated",
  "workflow.transitioned",
  "workflow.sla_breached",
  "entity.due_date_approaching",
  "system.error",
  "comment.created",
  "access_request.created",
  "access_request.updated",
] as const;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;

async function tick(): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // This sweep is deliberately cross-tenant, so it can't set
      // app.tenant_id — see setOutboxSweeperRole's doc comment.
      await setOutboxSweeperRole(tx);

      // Claims against notified_delivered_at, a column independent of
      // outbox-poller.ts's delivered_at — the automation engine and the
      // notification hub are two separate consumers of the same outbox and
      // must not race each other's claim (see 0040_notifications.sql).
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        event_type: string;
        version: number;
        payload: unknown;
      }>(sql`
        SELECT id, tenant_id, event_type, version, payload
        FROM outbox_events
        WHERE notified_delivered_at IS NULL
          AND event_type IN (${sql.join(
            NOTIFICATION_EVENT_TYPES.map((t) => sql`${t}`),
            sql`, `,
          )})
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH_SIZE}
      `);

      if (rows.length === 0) return;

      // jobId is the outbox event ID — BullMQ deduplicates by jobId, so a
      // re-added job after a rolled-back notified_delivered_at update is a
      // no-op rather than a duplicate.
      await Promise.all(
        rows.map((row) =>
          notifyQueue.add(
            row.event_type,
            {
              outboxEventId: row.id,
              tenantId: row.tenant_id,
              eventType: row.event_type,
              version: row.version,
              payload: row.payload,
            },
            { jobId: row.id },
          ),
        ),
      );

      await tx
        .update(outboxEvents)
        .set({ notifiedDeliveredAt: new Date() })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((r) => r.id),
          ),
        );

      logger.info(
        { count: rows.length },
        "Notification poller: delivered events to queue",
      );
    });
  } catch (err) {
    logger.error({ err }, "Notification poller tick failed");
  }
}

export function startNotificationPoller(
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    activeTick = tick();
  }, intervalMs);
  logger.info({ intervalMs }, "Notification poller started");
}

export async function stopNotificationPoller(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  logger.info({}, "Notification poller stopped");
}
