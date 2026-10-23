import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { getOrgBrandingHandler } from "./org.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.get("/org", ...getOrgBrandingHandler);

export { router as meRouter };
