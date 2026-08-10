/**
 * Due Date Scheduler — polls the outbox for `entity.due_date_scheduled` events
 * and enqueues a BullMQ delayed job for each one.
 *
 * Deliberately independent of sla-scheduler.ts/alert-scheduler.ts
 * (docs/specs/due-date.md §V) — separate file, separate queue (`due-date`),
 * separate poll loop. Never merged into shared code.
 *
 * The job ID is deterministic: `duedate-{outboxEventId}` (dash, not colon —
 * BullMQ rejects custom job ids containing ":").
 *
 * Reschedule/cancel: packages/entity-engine/src/engine.ts's rescheduleDueDate
 * marks any prior undelivered `entity.due_date_scheduled` row for an instance
 * as delivered before writing a fresh one, so this scheduler only ever sees
 * the live due_date. due-date-worker.ts additionally re-checks the instance's
 * current due_date at fire time (TOCTOU guard, mirroring sla-breacher.ts) —
 * so a job already enqueued for a superseded due_date still safely no-ops.
 *
 * Recovery after BullMQ downtime: on restart this scheduler re-polls the
 * outbox for undelivered `entity.due_date_scheduled` events. Events whose
 * dueDate is in the past (but within STALE_DUE_DATE_THRESHOLD_MS) are
 * enqueued with delay=0 so they fire immediately on recovery. There is no
 * dead-letter path — a due date passing a bit late is not an operational
 * incident; events past the threshold are marked delivered without being
 * enqueued (never fire), matching alert-scheduler.ts's approach, not
 * sla-scheduler.ts's (which dead-letters instead).
 */

import { sql, inArray } from "drizzle-orm";
import { db, outboxEvents, setOutboxSweeperRole } from "@platform/db";
import { logger } from "@platform/logger";
import { dueDateQueue } from "./queues.js";

export type DueDateJobData = {
  outboxEventId: string;
  tenantId: string;
  instanceId: string;
  entityTypeId: string;
  dueDate: string;
};

const BATCH_SIZE = 50;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

export const STALE_DUE_DATE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;

type DueDateOutboxRow = {
  id: string;
  tenant_id: string;
  payload: {
    instanceId: string;
    entityTypeId: string;
    dueDate: string;
  };
};

export async function tick(): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      // This sweep is deliberately cross-tenant, so it can't set
      // app.tenant_id — see setOutboxSweeperRole's doc comment.
      await setOutboxSweeperRole(tx);

      const rows = await tx.execute<DueDateOutboxRow>(sql`
        SELECT id, tenant_id, payload
        FROM outbox_events
        WHERE delivered_at IS NULL
          AND event_type = 'entity.due_date_scheduled'
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${BATCH_SIZE}
      `);

      if (rows.length === 0) return;

      const now = Date.now();
      const fresh: DueDateOutboxRow[] = [];
      const stale: DueDateOutboxRow[] = [];

      for (const row of rows) {
        const dueDate = new Date(row.payload.dueDate).getTime();
        if (Number.isNaN(dueDate)) {
          stale.push(row);
          continue;
        }
        const overdueMs = now - dueDate;
        if (overdueMs > STALE_DUE_DATE_THRESHOLD_MS) {
          stale.push(row);
        } else {
          fresh.push(row);
        }
      }

      if (stale.length > 0) {
        logger.warn(
          {
            count: stale.length,
            thresholdHours: STALE_DUE_DATE_THRESHOLD_MS / 3_600_000,
            outboxEventIds: stale.map((r) => r.id),
          },
          "Due date scheduler: marked stale events delivered without enqueuing",
        );
      }

      // Per-row isolation (allSettled, not all) — mirrors alert-scheduler.ts:
      // one row's enqueue failure must not poison the rest of the batch.
      const enqueueResults = await Promise.allSettled(
        fresh.map(async (row) => {
          const dueDate = new Date(row.payload.dueDate).getTime();
          const delay = Math.max(0, dueDate - now);
          const jobId = `duedate-${row.id}`;

          await dueDateQueue.add(
            "duedate.overdue",
            {
              outboxEventId: row.id,
              tenantId: row.tenant_id,
              instanceId: row.payload.instanceId,
              entityTypeId: row.payload.entityTypeId,
              dueDate: row.payload.dueDate,
            } satisfies DueDateJobData,
            { jobId, delay },
          );
          return row.id;
        }),
      );

      const enqueuedIds: string[] = [];
      const failedRows: { row: DueDateOutboxRow; err: unknown }[] = [];
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
          "Due date scheduler: enqueued overdue jobs",
        );
      }
      if (failedRows.length > 0) {
        logger.error(
          {
            count: failedRows.length,
            outboxEventIds: failedRows.map((f) => f.row.id),
            errs: failedRows.map((f) => String(f.err)),
          },
          "Due date scheduler: some rows failed to enqueue — left undelivered for retry next tick",
        );
      }

      const deliveredIds = [...stale.map((r) => r.id), ...enqueuedIds];
      if (deliveredIds.length > 0) {
        await tx
          .update(outboxEvents)
          .set({ deliveredAt: new Date() })
          .where(inArray(outboxEvents.id, deliveredIds));
      }
    });
  } catch (err) {
    logger.error({ err }, "Due date scheduler tick failed");
  }
}

export function startDueDateScheduler(
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

  logger.info({ intervalMs }, "Due date scheduler started");
}

export async function stopDueDateScheduler(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  logger.info({}, "Due date scheduler stopped");
}
