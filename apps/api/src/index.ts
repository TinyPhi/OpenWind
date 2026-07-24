import { serve } from "@hono/node-server";
import { logger } from "@platform/logger";
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
