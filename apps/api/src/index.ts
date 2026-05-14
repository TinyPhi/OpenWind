import { logger } from "@platform/logger";
import { createApp } from "./app.js";

const app = createApp();
const port = 3000;

logger.info({ port }, "API server starting");

export default { port, fetch: app.fetch };
