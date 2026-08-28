import { logger } from "@platform/logger";

// ioredis queues commands while disconnected/reconnecting rather than
// rejecting immediately (enableOfflineQueue defaults to true), so an
// unreachable/slow Redis doesn't fail fast on its own — a command can sit
// queued for many seconds (bounded by maxRetriesPerRequest's backoff) before
// ever settling. Extracted from rate-limit.ts's own CHECK_TIMEOUT_MS pattern
// (security-reviewer finding, ADR-012 Phase F PR) so every hot-path Redis
// caller gets the same bounded "fail open" guarantee, not just checkRateLimit.
const DEFAULT_TIMEOUT_MS = 250;

/**
 * Races `fn()` against a timeout. On timeout OR any thrown error, logs a
 * warning and returns `fallback` instead of propagating — callers on a
 * request's hot path must never hang or fail closed just because Redis is
 * slow or unreachable.
 */
export async function withRedisTimeout<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  try {
    return await Promise.race([
      fn().finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("redis call timed out")),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    logger.warn({ err, ...context }, "Redis call failed — failing open");
    return fallback;
  }
}
