import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { setConnectorDisabledHandler } from "./set-disabled.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.patch("/:connectorId/disabled", ...setConnectorDisabledHandler);

export { router as connectorsRouter };
