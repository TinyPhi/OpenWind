import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { myViewHandler } from "./my-view.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.get("/my-view", ...myViewHandler);

export { router as dashboardRouter };
