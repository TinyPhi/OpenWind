import type { Redis } from "ioredis";
import { logger } from "@platform/logger";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// ioredis queues commands while disconnected/reconnecting rather than
// rejecting immediately (enableOfflineQueue defaults to true), so an
// unreachable Redis doesn't fail fast on its own — a command can sit queued
// for many seconds (bounded by maxRetriesPerRequest's backoff) before ever
// settling. Every caller of this function is on a request's hot path
// (an API request, an auth check), so "fail open" has to be a real, bounded
// guarantee — not just "eventually rejects" — or a Redis outage turns into a
// full request hang instead of graceful degradation.
const CHECK_TIMEOUT_MS = 250;

/**
 * Sliding window via a sorted set. Each member is a unique timestamped key.
 * The window removes entries older than `windowSeconds` before counting.
 * Shared by apps/api's pre-auth IP-based stage and @platform/auth's post-auth
 * tenant-scoped stage (#195) so both use one implementation.
 *
 * Fails open (never throws) on any error or timeout — allows the request and
 * logs a warning. The alternative (blocking/rejecting the request) would mean
 * a Redis outage takes down every rate-limited path along with it, which is
 * worse than temporarily not rate-limiting.
 */
export async function checkRateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const resetAt = Math.ceil(Date.now() / 1000) + windowSeconds;
  try {
    return await Promise.race([
      runCheck(redis, key, limit, windowSeconds),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("rate-limit check timed out")),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    logger.warn({ err, key }, "Rate limit check failed — failing open");
    return { allowed: true, remaining: limit, resetAt };
  }
}

async function runCheck(
  redis: Redis,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const resetAt = Math.ceil(now / 1000) + windowSeconds;
  const member = `${now}-${Math.random().toString(36).slice(2)}`;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zadd(key, now, member);
  pipeline.zcard(key);
  pipeline.expire(key, windowSeconds * 2);
  const results = await pipeline.exec();

  const count = (results?.[2]?.[1] as number | undefined) ?? 0;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt,
  };
}
