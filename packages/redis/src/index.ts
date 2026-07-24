import Redis from "ioredis";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

export type { Redis };

// Shared pub/sub channel: apps/worker's notification worker (a separate
// process from apps/api) publishes here after writing a notification, and
// apps/api's websocket layer subscribes to forward it to any open connection
// for that (tenantId, userId). Living here since both apps already depend on
// @platform/redis — avoids a one-off constant duplicated in two apps.
export const NOTIFICATION_PUSH_CHANNEL = "notification:push";

let _client: Redis | null = null;

/**
 * Returns the shared ioredis client, creating it on first call.
 * The same instance is reused across the process lifetime.
 */
export function getRedis(): Redis {
  if (!_client) {
    _client = new Redis(env.REDIS_URL, { lazyConnect: false });
    _client.on("error", (err: unknown) => {
      logger.error({ err }, "Redis client error");
    });
  }
  return _client;
}

/** Graceful shutdown — call from process SIGTERM handler. */
export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}
