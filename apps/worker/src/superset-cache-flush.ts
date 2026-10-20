/**
 * superset-cache-flush.ts
 *
 * BullMQ processor for the "superset-cache-flush" queue (#728, slice 1 of
 * docs/specs/superset-gdpr-erasure.md).
 *
 * Superset caches query results in Redis under opaque hashed keys (prefixes `superset_` and
 * `superset_data_`, TTL 300 s), not namespaced by tenant or user, so a user's data cannot be
 * evicted selectively. A user erasure or tenant purge therefore flushes both prefixes in
 * Superset's own Redis db (SUPERSET_REDIS_URL), which clears every tenant's cached results and
 * costs only a re-query. Nothing outside those prefixes, and no other db, is touched.
 */

import Redis from "ioredis";
import { Worker } from "@platform/telemetry";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { connection, supersetCacheFlushQueue } from "./queues.js";

export const SUPERSET_CACHE_PREFIXES = ["superset_", "superset_data_"] as const;

const SCAN_COUNT = 500;

export type SupersetCacheFlushReason = "user_erased" | "tenant_purged";

export interface SupersetCacheFlushJob {
  tenantId: string;
  reason: SupersetCacheFlushReason;
}

/** Deletes every key under the Superset cache prefixes in the client's db; returns how many. */
export async function flushSupersetCache(redis: Redis): Promise<number> {
  let removed = 0;
  for (const prefix of SUPERSET_CACHE_PREFIXES) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        SCAN_COUNT,
      );
      cursor = next;
      if (keys.length > 0) removed += await redis.unlink(...keys);
    } while (cursor !== "0");
  }
  return removed;
}

// Requests inside one window share a job, since a flush after the last erasure covers the
// earlier ones. A job from an earlier window no longer blocks a new one.
const COALESCE_WINDOW_MS = 10_000;

/**
 * Queues a flush. Off when SUPERSET_REDIS_URL is unset. Never throws: the caller's erasure or
 * purge has already committed, and a failed enqueue must not undo or fail it.
 */
export async function enqueueSupersetCacheFlush(
  tenantId: string,
  reason: SupersetCacheFlushReason,
): Promise<boolean> {
  if (!env.SUPERSET_REDIS_URL) return false;
  try {
    await supersetCacheFlushQueue.add(
      "flush",
      { tenantId, reason } satisfies SupersetCacheFlushJob,
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

export const supersetCacheFlushWorker = new Worker<SupersetCacheFlushJob>(
  "superset-cache-flush",
  async (job) => {
    const url = env.SUPERSET_REDIS_URL;
    if (!url) return;
    const redis = new Redis(url, { maxRetriesPerRequest: null });
    try {
      const removed = await flushSupersetCache(redis);
      logger.info(
        { tenantId: job.data.tenantId, reason: job.data.reason, removed },
        "superset cache flushed",
      );
    } finally {
      redis.disconnect();
    }
  },
  { connection, concurrency: 1 },
);

supersetCacheFlushWorker.on("failed", (job, err) => {
  if (!job) return;
  const finalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  logger.error(
    {
      tenantId: job.data.tenantId,
      reason: job.data.reason,
      attempt: job.attemptsMade,
      finalAttempt,
      err,
    },
    "superset cache flush failed",
  );
});

export function stopSupersetCacheFlushWorker(): Promise<void> {
  return supersetCacheFlushWorker.close();
}
