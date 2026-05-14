import { createMiddleware } from "hono/factory";
import { Redis } from "ioredis";
import type { MiddlewareHandler } from "hono";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

const redis = new Redis(env.REDIS_URL, { lazyConnect: true });

redis.on("error", (err: unknown) => {
  logger.error({ error: String(err) }, "Rate limiter Redis error");
});

// Sliding window via a sorted set. Each member is a unique timestamped key.
// The window removes entries older than `windowMs` before counting.
async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
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

export interface RateLimitOptions {
  limit?: number;
  windowSeconds?: number;
  // Override limit for paths starting with these prefixes
  authLimit?: number;
}

export const rateLimit = (options: RateLimitOptions = {}): MiddlewareHandler =>
  createMiddleware(async (c, next) => {
    const isAuthRoute =
      c.req.path.startsWith("/auth") || c.req.path.startsWith("/api-keys");
    const limit = isAuthRoute
      ? (options.authLimit ?? 10)
      : (options.limit ?? 100);
    const windowSeconds = options.windowSeconds ?? 60;

    // Key by tenant if authenticated, otherwise by IP
    const auth = c.get("auth") as { tenantId?: string } | undefined;
    const tenantId =
      auth?.tenantId ??
      c.req.header("x-forwarded-for") ??
      c.req.header("x-real-ip") ??
      "unknown";
    const routeClass = isAuthRoute ? "auth" : "api";
    const key = `rl:${tenantId}:${routeClass}`;

    const { allowed, remaining, resetAt } = await checkRateLimit(
      key,
      limit,
      windowSeconds,
    );

    c.header("x-ratelimit-limit", String(limit));
    c.header("x-ratelimit-remaining", String(remaining));
    c.header("x-ratelimit-reset", String(resetAt));

    if (!allowed) {
      return c.json(
        { error: "RATE_LIMITED", message: "Too many requests" },
        429,
      );
    }

    await next();
    return;
  });
