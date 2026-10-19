import "@platform/telemetry/instrumentation.js";
import { startErrorTracking } from "@platform/telemetry";
startErrorTracking();
import { serve } from "@hono/node-server";
import { logger } from "@platform/logger";
import { env } from "@platform/config";
import { closeRedis } from "@platform/redis";
import {
  startTenantStatusInvalidationSubscriber,
  stopTenantStatusInvalidationSubscriber,
} from "@platform/auth";
import { createApp } from "./app.js";
import { ModuleService } from "./services/module-service.js";
import {
  attachNotificationWebSocket,
  stopNotificationWebSocket,
} from "./websocket/notifications.js";

const app = createApp();
const port = 3000;

logger.info({ port }, "API server starting");

if (env.NODE_ENV === "production") {
  // TRUST_PROXY defaults to "false" in the config schema, so unset reaches here as "false".
  if (env.TRUST_PROXY === "false") {
    logger.warn(
      {},
      "TRUST_PROXY is false in production: behind a reverse proxy every client shares one rate-limit bucket; see docs/deployment-hardening.md",
    );
  }
  if (!env.PLATFORM_ORG_ID) {
    logger.warn(
      {},
      "PLATFORM_ORG_ID is not set in production: the /admin/tenants routes refuse every caller until it is",
    );
  }
}

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, "API server listening");
  startTenantStatusInvalidationSubscriber();
  ModuleService.seedRegistry().catch((err: unknown) => {
    logger.error({ err }, "Failed to seed modules registry on startup");
  });
});

attachNotificationWebSocket(server);

async function shutdown(): Promise<void> {
  logger.info({}, "API server shutting down");
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await stopTenantStatusInvalidationSubscriber();
  await stopNotificationWebSocket();
  await closeRedis();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
