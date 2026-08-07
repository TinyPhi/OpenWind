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
      // Only claims outbox event types that are actually automation triggers —
      // i.e. the exact literals in TriggerEventSchema's discriminated union
      // (packages/automation-engine/src/event-schemas.ts). A positive allowlist,
      // not a negative denylist: a denylist means every *new* outbox event type
      // that isn't an automation trigger (workflow.sla_scheduled, system.error,
      // and any future Phase 3 connector/system event) is claimed by default and
      // silently breaks its real consumer — which is exactly how the
      // workflow.sla_scheduled bug happened (this poller's 2s interval usually
      // wins the FOR UPDATE SKIP LOCKED race against sla-scheduler.ts's dedicated
      // 10s query, marks the row delivered, and hands it to automationWorker,
      // which rejects it with INVALID_EVENT_PAYLOAD — so sla-scheduler never sees
      // the row again and the SLA breach check is silently never scheduled).
      // With an allowlist, a new non-trigger event type is excluded by default
      // instead of requiring someone to remember to add it here. Found while
      // investigating #120's outbox-depth handling.
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
          AND event_type IN ('workflow.transitioned', 'workflow.sla_breached', 'entity.created', 'entity.assigned', 'entity.due_date_overdue')
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
