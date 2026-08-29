import type { MiddlewareHandler } from "hono";
import { httpRequestsTotal, httpRequestDuration } from "@platform/telemetry";

interface TelemetryEnv {
  Variables: {
    auth?: {
      tenantId: string;
    };
  };
}

export function telemetry(): MiddlewareHandler<TelemetryEnv> {
  return async (c, next) => {
    const path = c.req.path;
    // Skip metrics and health check paths to avoid telemetry noise
    if (path === "/metrics" || path === "/health" || path === "/healthz") {
      return await next();
    }

    const start = performance.now();
    await next();
    const duration = (performance.now() - start) / 1000;

    const route = c.req.routePath;
    const method = c.req.method;
    const status = String(c.res.status);

    const labels = {
      method,
      route,
      status,
    };

    httpRequestsTotal.add(1, labels);
    httpRequestDuration.record(duration, labels);
  };
}
