import { sql, inArray } from "drizzle-orm";
import { db, outboxEvents } from "@platform/db";
import { logger } from "@platform/logger";
import { automationQueue } from "./queues.js";

const BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;

async function tick(): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const rows = await tx.execute<{
        id: string;
        tenant_id: string;
        event_type: string;
        version: number;
        payload: unknown;
      }>(sql`
        SELECT id, tenant_id, event_type, version, payload
        FROM outbox_events
        WHERE delivered_at IS NULL
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH_SIZE}
      `);

      if (rows.length === 0) return;

      // jobId is the outbox event ID — BullMQ deduplicates by jobId, so if the
      // delivered_at update below rolls back and this tick re-runs, re-adding the
      // same job is a no-op rather than producing a duplicate execution.
      await Promise.all(
        rows.map((row) =>
          automationQueue.add(
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
        .set({ deliveredAt: new Date() })
        .where(
          inArray(
            outboxEvents.id,
            rows.map((r) => r.id),
          ),
        );

      logger.info({ count: rows.length }, "Outbox: delivered events to queue");
    });
  } catch (err) {
    logger.error({ err }, "Outbox poller tick failed");
  }
}

export function startOutboxPoller(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    activeTick = tick();
  }, intervalMs);
  logger.info({ intervalMs }, "Outbox poller started");
}

export async function stopOutboxPoller(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  logger.info({}, "Outbox poller stopped");
}
