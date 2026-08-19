/**
 * Due Date Approaching Worker — ui-feature-checklist-and-rules.md §2.8.
 *
 * BullMQ worker that fires DUE_DATE_APPROACHING_LEAD_MS (2 days) before a
 * ticket's due date. Mirrors due-date-worker.ts's TOCTOU guard (re-checks the
 * instance still exists, isn't archived, and its due_date still equals the
 * value the job was scheduled for) for the same reason: due-date-scheduler.ts
 * enqueues this job once per `entity.due_date_scheduled` outbox row, and a
 * reschedule after that point supersedes the row but can't cancel an
 * already-enqueued BullMQ job.
 *
 * Additionally skips firing if the due date has already passed by the time
 * this job runs (e.g. the worker was down through the entire lead window) —
 * an "approaching" warning for an already-overdue ticket would be confusing;
 * the separate overdue path (due-date-worker.ts) covers that case.
 */

import { Worker } from "bullmq";
import { eq, and } from "drizzle-orm";
import { withTenantContext, outboxEvents, entityInstances } from "@platform/db";
import { logger } from "@platform/logger";
import { connection } from "./queues.js";
import type { DueDateJobData } from "./due-date-scheduler.js";
import { validateActiveTenant } from "./tenant-guard.js";

export const dueDateApproachingWorker = new Worker<DueDateJobData>(
  "due-date-approaching",
  async (job) => {
    const { outboxEventId, tenantId, instanceId, entityTypeId, dueDate } =
      job.data;

    const active = await validateActiveTenant(
      tenantId,
      "Due date approaching check",
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
          "Due date approaching: instance not found or archived — skipping",
        );
        return;
      }

      const scheduledTime = new Date(dueDate).getTime();
      const currentTime = instance.dueDate?.getTime() ?? null;
      if (currentTime !== scheduledTime) {
        logger.info(
          { tenantId, instanceId, outboxEventId, scheduledTime, currentTime },
          "Due date approaching: due_date changed since scheduling — skipping",
        );
        return;
      }

      if (scheduledTime <= Date.now()) {
        logger.info(
          { tenantId, instanceId, outboxEventId },
          "Due date approaching: due date already passed — skipping (overdue path covers this)",
        );
        return;
      }

      await tx.insert(outboxEvents).values({
        tenantId,
        eventType: "entity.due_date_approaching",
        version: 1,
        payload: {
          eventType: "entity.due_date_approaching",
          version: 1,
          tenantId,
          instanceId,
          entityTypeId,
          dueDate,
        },
      });

      logger.info(
        { tenantId, instanceId, dueDate, outboxEventId },
        "Due date approaching: outbox event written",
      );
    });
  },
  { connection },
);

dueDateApproachingWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, data: job?.data, err },
    "Due date approaching job failed",
  );
});
