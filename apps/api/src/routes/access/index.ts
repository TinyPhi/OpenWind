import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { getAccessHandler } from "./access.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.get("/access", ...getAccessHandler);

export { router as accessRouter };
