import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { env } from "@platform/config";
import { correlationId } from "./middleware/correlation-id.js";
import { errorHandler } from "./middleware/error-handler.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { entityTypesRouter } from "./routes/entity-types/index.js";
import { entitiesRouter } from "./routes/entities/index.js";
import { workflowsRouter } from "./routes/workflows/index.js";

export function createApp(): Hono {
  const app = new Hono();

  // Middleware order matters:
  // 1. Correlation ID — must be first so all downstream logs carry the request ID
  app.use("*", correlationId());
  // 2. Hono request logger
  app.use("*", honoLogger());
  // 3. Rate limiter — before auth so unauthenticated flood is blocked cheaply
  app.use("*", rateLimit());
  // 4. Error handler — registered last so it wraps all subsequent route errors
  app.use("*", errorHandler());

  app.get("/health", (c) => c.json({ status: "ok", env: env.NODE_ENV }));

  app.route("/entity-types", entityTypesRouter);
  app.route("/entities", entitiesRouter);
  app.route("/workflows", workflowsRouter);

  return app;
}
