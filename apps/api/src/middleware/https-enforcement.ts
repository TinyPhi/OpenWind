import { createMiddleware } from "hono/factory";
import { env } from "@platform/config";

/**
 * ADR-012 Phase G, spec R10 — TLS/HTTPS-only enforcement point for external
 * callers.
 *
 * This process itself never terminates TLS (see docker-compose.yml — no
 * nginx/caddy/traefik config exists in this repo; TLS termination happens
 * at a reverse-proxy/load-balancer layer entirely outside this codebase's
 * visibility). Because of that, this app-level check can only act on the
 * `x-forwarded-proto` header the proxy sets — it cannot independently
 * verify the proxy itself is actually configured for HTTPS-only ingress.
 * Documented here rather than assumed (spec R10's explicit ask): if the
 * header is ABSENT, this middleware cannot tell http from https and does
 * NOT reject (a false rejection would break local dev and any correctly
 * terminated request from a proxy that doesn't set this header) — it only
 * rejects when the header is explicitly present and says "http".
 *
 * Only active when NODE_ENV=production, matching the same pattern
 * app.ts's CORS_ORIGIN enforcement already uses — local dev and CI run
 * over plain http.
 */
export const httpsEnforcement = (): ReturnType<typeof createMiddleware> =>
  createMiddleware(async (c, next) => {
    if (env.NODE_ENV === "production") {
      const proto = c.req.header("x-forwarded-proto");
      if (proto && proto !== "https") {
        const url = new URL(c.req.url);
        url.protocol = "https:";
        return c.redirect(url.toString(), 301);
      }
    }
    await next();
    return;
  });
