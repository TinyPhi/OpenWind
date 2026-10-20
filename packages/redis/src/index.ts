import Redis from "ioredis";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

export type { Redis };
export { checkRateLimit } from "./rate-limit.js";
export type { RateLimitResult } from "./rate-limit.js";
export { withRedisTimeout } from "./with-timeout.js";

// Shared pub/sub channel: apps/worker's notification worker (a separate
// process from apps/api) publishes here after writing a notification, and
// apps/api's websocket layer subscribes to forward it to any open connection
// for that (tenantId, userId). Living here since both apps already depend on
// @platform/redis — avoids a one-off constant duplicated in two apps.
export const NOTIFICATION_PUSH_CHANNEL = "notification:push";

let _client: Redis | null = null;
let _cacheClient: Redis | null = null;

function connect(url: string, name: string): Redis {
  const client = new Redis(url, { lazyConnect: false });
  client.on("error", (err: unknown) => {
    logger.error({ err, instance: name }, "Redis client error");
  });
  return client;
}

/**
 * Returns the shared ioredis client for the queue/state instance (REDIS_URL), creating it on
 * first call. This instance must run `noeviction`: BullMQ jobs and locks, rate-limit counters and
 * MFA markers live here. The same instance is reused across the process lifetime.
 */
export function getRedis(): Redis {
  if (!_client) {
    if (env.NODE_ENV === "production" && !env.REDIS_CACHE_URL) {
      logger.warn(
        {},
        "REDIS_CACHE_URL is not set in production: cache keys share the queue/state Redis; see docs/deployment-hardening.md",
      );
    }
    _client = connect(env.REDIS_URL, "state");
  }
  return _client;
}

/**
 * Returns the client for disposable cache keys. With REDIS_CACHE_URL set this is a separate
 * instance that may evict (LRU); unset, it is the same client as getRedis(). Only put data here
 * that can be rebuilt, and never anything a security decision or a job depends on.
 */
export function getCacheRedis(): Redis {
  if (!env.REDIS_CACHE_URL || env.REDIS_CACHE_URL === env.REDIS_URL) {
    return getRedis();
  }
  _cacheClient ??= connect(env.REDIS_CACHE_URL, "cache");
  return _cacheClient;
}

/** Graceful shutdown — call from process SIGTERM handler. */
export async function closeRedis(): Promise<void> {
  const clients = [_client, _cacheClient];
  _client = null;
  _cacheClient = null;
  await Promise.all(clients.flatMap((c) => (c ? [c.quit()] : [])));
}
