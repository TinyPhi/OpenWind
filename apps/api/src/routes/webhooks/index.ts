import { Hono } from "hono";
import { webhookGatewayHandler } from "./handler.js";

const router = new Hono();

router.post("/:connectorId/:tenantId", ...webhookGatewayHandler);

export { router as webhooksRouter };
