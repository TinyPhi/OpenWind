import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { getRedis, checkRateLimit } from "@platform/redis";

export interface RateLimitOptions {
  limit?: number;
  windowSeconds?: number;
  // Override limit for paths starting with these prefixes
  authLimit?: number;
}

/**
 * Pre-auth flood guard — runs before requireAuth() has verified anything, so
 * the ONLY safe identity to key on is the transport-level client IP. This
 * used to also try decoding (not verifying) a bearer token's claims, which
 * let a client evade its bucket entirely by varying an unverified claim per
 * request (#195) — requireAuth() (@platform/auth) now runs a second,
 * tenant-scoped check on the *verified* auth.tenantId after authentication,
 * which is the layer that actually needs to be unforgeable.
 */
function rateLimitKey(c: Parameters<MiddlewareHandler>[0]): string {
  return (
    c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown"
  );
}

export const rateLimit = (options: RateLimitOptions = {}): MiddlewareHandler =>
  createMiddleware(async (c, next) => {
    const isAuthRoute =
      c.req.path.startsWith("/auth") || c.req.path.startsWith("/api-keys");
    const limit = isAuthRoute
      ? (options.authLimit ?? 10)
      : (options.limit ?? 500);
    const windowSeconds = options.windowSeconds ?? 60;

    const clientIp = rateLimitKey(c);
    const routeClass = isAuthRoute ? "auth" : "api";
    const key = `rl:ip:${clientIp}:${routeClass}`;

    const { allowed, remaining, resetAt } = await checkRateLimit(
      getRedis(),
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
