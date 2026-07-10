/**
 * In-process tenant status cache with best-effort cross-instance invalidation.
 *
 * Avoids a DB round-trip on every authenticated request. 30 s TTL caps the
 * staleness window for any instance that never receives the invalidation
 * message below (e.g. Redis briefly unavailable). `invalidateTenantStatusCache`
 * clears the local cache immediately, then publishes the tenantId on a Redis
 * pub/sub channel so every other API replica clears its own local cache too —
 * `startTenantStatusInvalidationSubscriber` (called once at server startup)
 * is what makes each replica listen for that message.
 */

import { getRedis } from "@platform/redis";
import type { Redis } from "@platform/redis";
import { logger } from "@platform/logger";

const TTL_MS = 30_000;
const INVALIDATION_CHANNEL = "tenant-status:invalidate";

const _cache = new Map<string, { status: string; exp: number }>();

export function getCachedTenantStatus(tenantId: string): string | undefined {
  const entry = _cache.get(tenantId);
  if (!entry) return undefined;
  if (Date.now() > entry.exp) {
    _cache.delete(tenantId);
    return undefined;
  }
  return entry.status;
}

export function setCachedTenantStatus(tenantId: string, status: string): void {
  _cache.set(tenantId, { status, exp: Date.now() + TTL_MS });
}

export function invalidateTenantStatusCache(tenantId: string): void {
  _cache.delete(tenantId);

  // Best-effort cross-instance propagation. If Redis is down, other replicas
  // just fall back to the existing TTL -- no worse than before this channel
  // existed.
  const redis = getRedis();
  if (redis.status === "ready") {
    redis.publish(INVALIDATION_CHANNEL, tenantId).catch((err: unknown) => {
      logger.warn(
        { err, tenantId },
        "Failed to publish tenant-status invalidation",
      );
    });
  }
}

let _subscriber: Redis | null = null;

/**
 * Subscribes this process to cross-instance invalidation messages. Call once
 * at server startup (a dedicated connection is required -- ioredis clients in
 * subscribe mode can't run other commands, so this can't share the main
 * getRedis() client).
 */
export function startTenantStatusInvalidationSubscriber(): void {
  if (_subscriber) return;

  _subscriber = getRedis().duplicate();
  _subscriber.on("error", (err: unknown) => {
    logger.error({ err }, "Tenant-status invalidation subscriber error");
  });
  _subscriber.subscribe(INVALIDATION_CHANNEL).catch((err: unknown) => {
    logger.error(
      { err },
      "Failed to subscribe to tenant-status invalidation channel",
    );
  });
  _subscriber.on("message", (channel: string, tenantId: string) => {
    if (channel === INVALIDATION_CHANNEL) _cache.delete(tenantId);
  });
}

export async function stopTenantStatusInvalidationSubscriber(): Promise<void> {
  if (_subscriber) {
    await _subscriber.quit();
    _subscriber = null;
  }
}
