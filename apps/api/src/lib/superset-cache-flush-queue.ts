import { Queue } from "@platform/telemetry";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { connection } from "./redis.js";

export type SupersetCacheFlushReason = "user_erased" | "tenant_purged";

// Same queue name as apps/worker/src/queues.ts, which owns the consumer and the job options.
export const supersetCacheFlushQueue = new Queue("superset-cache-flush", {
  connection,
  defaultJobOptions: {
    attempts: 8,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { age: 3_600 },
    removeOnFail: { age: 604_800 },
  },
});

// Requests in one window share a job: a flush after the last erasure covers the earlier ones.
const COALESCE_WINDOW_MS = 10_000;

/**
 * Queues a flush of Superset's cached query results (#728). Off when SUPERSET_REDIS_URL is unset.
 * Never throws: the erasure has already committed, and a failed enqueue must not fail it.
 */
export async function enqueueSupersetCacheFlush(
  tenantId: string,
  reason: SupersetCacheFlushReason,
): Promise<boolean> {
  if (!env.SUPERSET_REDIS_URL) return false;
  try {
    await supersetCacheFlushQueue.add(
      "flush",
      { tenantId, reason },
      {
        jobId: `superset-cache-flush-${Math.floor(Date.now() / COALESCE_WINDOW_MS)}`,
      },
    );
    return true;
  } catch (err) {
    logger.warn(
      { tenantId, reason, err },
      "superset cache flush could not be queued; Superset cached results expire on their own within 300 s",
    );
    return false;
  }
}
