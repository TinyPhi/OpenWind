import { serve } from "@hono/node-server";
import { logger } from "@platform/logger";
import { closeRedis } from "@platform/redis";
import { createApp } from "./app.js";
import { ModuleService } from "./services/module-service.js";

const app = createApp();
const port = 3000;

logger.info({ port }, "API server starting");

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, "API server listening");
  ModuleService.seedRegistry().catch((err: unknown) => {
    logger.error({ err }, "Failed to seed modules registry on startup");
  });
});

async function shutdown(): Promise<void> {
  logger.info({}, "API server shutting down");
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await closeRedis();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
