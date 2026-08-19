import { createMiddleware } from "hono/factory";
import type { MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getRedis, checkRateLimit } from "@platform/redis";
import { logger } from "@platform/logger";

export interface RateLimitOptions {
  limit?: number;
  windowSeconds?: number;
  // Override limit for paths starting with these prefixes
  authLimit?: number;
}

// X-Forwarded-For is a comma-separated hop chain (client, proxy1, proxy2...)
// — using the raw header verbatim as a Redis key let a single misbehaving
// hop (or a client-supplied prefix a proxy appends to rather than
// overwrites) produce a different key per request and dodge its bucket, or
// merge unrelated requests into one key if the chain length varies. Take
// only the first hop (the original client, by convention) and trim it.
function firstForwardedIp(header: string): string | null {
  const first = header.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * Pre-auth flood guard — runs before requireAuth() has verified anything, so
 * the ONLY safe identity to key on is the transport-level client IP. This
 * used to also try decoding (not verifying) a bearer token's claims, which
 * let a client evade its bucket entirely by varying an unverified claim per
 * request (#195) — requireAuth() (@platform/auth) now runs a second,
 * tenant-scoped check on the *verified* auth.tenantId after authentication,
 * which is the layer that actually needs to be unforgeable.
 *
 * Neither x-forwarded-for nor x-real-ip is set by anything in local dev (no
 * reverse proxy in front of the API there — see docs/local-setup.md), and a
 * misconfigured prod proxy that drops or overwrites these headers hits the
 * same gap. Previously that fell back to the literal string "unknown" for
 * every request with neither header — a single shared bucket across every
 * client, in every environment, which is the actual cause of "random" 429s
 * reported even with a single developer/browser in local dev (a handful of
 * concurrent requests on one page load can exhaust the 10/min auth-route
 * budget by itself). Falling back to the raw TCP peer address instead scopes
 * that failure mode to "one bucket per direct connection" rather than "one
 * bucket, period" — still collapsed if a reverse proxy multiplexes many
 * real clients over one connection to us without setting either header, but
 * that misconfiguration should be fixed at the proxy, not papered over here.
 */
function rateLimitKey(c: Parameters<MiddlewareHandler>[0]): string {
  const forwardedFor = c.req.header("x-forwarded-for");
  const fromForwardedFor = forwardedFor ? firstForwardedIp(forwardedFor) : null;
  if (fromForwardedFor) return fromForwardedFor;

  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;

  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    // getConnInfo needs the underlying Node socket (c.env.incoming) —
    // unavailable under Hono's app.request() test harness and on non-node
    // runtimes. Falls through to the shared bucket below.
  }

  logger.warn(
    {},
    "rate-limit: no x-forwarded-for/x-real-ip header and no connection info available — using shared fallback bucket",
  );
  return "unknown";
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
