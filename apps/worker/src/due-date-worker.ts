/**
 * Due Date Worker — BullMQ worker that fires when a delayed due-date job
 * becomes due.
 *
 * Guard: before writing the overdue event it re-checks that the instance
 * still exists, isn't archived/deleted, and its due_date still equals the
 * value the job was scheduled for (TOCTOU guard, mirroring sla-breacher.ts).
 * If the due_date was cleared or changed since scheduling, or the instance
 * was archived, the job is a no-op — engine.ts's rescheduleDueDate already
 * superseded the outbox row, but a job already enqueued before that happened
 * still needs this guard to avoid a stale/duplicate fire (docs/specs/
 * due-date.md R5/R6).
 *
 * Atomicity: the guard SELECT and the outbox INSERT are wrapped in a single
 * transaction (withTenantContext), matching sla-breacher.ts's G1 rationale.
 */

import { Worker } from "bullmq";
import { eq, and } from "drizzle-orm";
import { withTenantContext, outboxEvents, entityInstances } from "@platform/db";
import { logger } from "@platform/logger";
import { connection } from "./queues.js";
import type { DueDateJobData } from "./due-date-scheduler.js";
import { validateActiveTenant } from "./tenant-guard.js";

export const dueDateWorker = new Worker<DueDateJobData>(
  "due-date",
  async (job) => {
    const { outboxEventId, tenantId, instanceId, entityTypeId, dueDate } =
      job.data;

    const active = await validateActiveTenant(
      tenantId,
      "Due date overdue check",
      { instanceId, outboxEventId, jobId: job.id },
    );
    if (!active) return;

    await withTenantContext(tenantId, async (tx) => {
      const [instance] = await tx
        .select({
          dueDate: entityInstances.dueDate,
          deletedAt: entityInstances.deletedAt,
        })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, instanceId),
            eq(entityInstances.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!instance || instance.deletedAt) {
        logger.info(
          { tenantId, instanceId, outboxEventId },
          "Due date overdue: instance not found or archived — skipping",
        );
        return;
      }

      const scheduledTime = new Date(dueDate).getTime();
      const currentTime = instance.dueDate?.getTime() ?? null;
      if (currentTime !== scheduledTime) {
        logger.info(
          { tenantId, instanceId, outboxEventId, scheduledTime, currentTime },
          "Due date overdue: due_date changed since scheduling — skipping",
        );
        return;
      }

      await tx.insert(outboxEvents).values({
        tenantId,
        eventType: "entity.due_date_overdue",
        version: 1,
        payload: {
          eventType: "entity.due_date_overdue",
          version: 1,
          tenantId,
          instanceId,
          entityTypeId,
          dueDate,
          overdueAt: new Date().toISOString(),
        },
      });

      logger.info(
        { tenantId, instanceId, dueDate, outboxEventId },
        "Due date overdue: outbox event written",
      );
    });
  },
  { connection },
);

dueDateWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, data: job?.data, err },
    "Due date overdue job failed",
  );
});
