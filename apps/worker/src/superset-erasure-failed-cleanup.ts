import type { Queue } from "bullmq";
import { logger } from "@platform/logger";
import {
  SUPERSET_ERASURE_COMPLETED_RETENTION_SECONDS,
  SUPERSET_ERASURE_FAILED_RETENTION_SECONDS,
} from "./superset-erasure-options.js";

/** Most failed jobs removed per call; the next sweep removes the rest. */
export const FAILED_CLEAN_LIMIT = 1_000;

/**
 * Removes failed erasure jobs that failed more than the retention period ago. A failed job's
 * payload `{kind, tenantId, subject}` names the person being erased, and BullMQ's own
 * `removeOnFail.age` only trims at the moment another job fails, so without this a failure that is
 * never followed by another one keeps the payload in Redis indefinitely (ADR-019 Stage 2
 * criterion 15). `clean` ages a failed job by `finishedOn`, the time it failed, not its creation.
 * Runs from the reconcile sweep, so a worker that is down removes nothing until it is back.
 */
export async function cleanSupersetErasureFailedJobs(
  queue: Pick<Queue, "clean">,
): Promise<number> {
  const removed = await queue.clean(
    SUPERSET_ERASURE_FAILED_RETENTION_SECONDS * 1_000,
    FAILED_CLEAN_LIMIT,
    "failed",
  );
  if (removed.length > 0) {
    logger.info(
      { removed: removed.length },
      "superset-erasure: removed failed jobs past their retention",
    );
  }
  return removed.length;
}

/**
 * Removes finished erasure jobs, failed and completed, once they are past their retention. A completed
 * job's payload names the person who was erased just as a failed one does, and `removeOnComplete.age`
 * is just as lazy: it trims only when another job in the queue completes, so the last erasure for a
 * quiet tenant would keep its subject in Redis indefinitely.
 */
export async function cleanSupersetErasureFinishedJobs(
  queue: Pick<Queue, "clean">,
): Promise<{ failed: number; completed: number }> {
  const failed = await cleanSupersetErasureFailedJobs(queue);
  const removedCompleted = await queue.clean(
    SUPERSET_ERASURE_COMPLETED_RETENTION_SECONDS * 1_000,
    FAILED_CLEAN_LIMIT,
    "completed",
  );
  if (removedCompleted.length > 0) {
    logger.info(
      { removed: removedCompleted.length },
      "superset-erasure: removed completed jobs past their retention",
    );
  }
  return { failed, completed: removedCompleted.length };
}
