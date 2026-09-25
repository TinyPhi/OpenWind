import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { guestTokenHandler } from "./guest-token.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.get("/guest-token", ...guestTokenHandler);

export { router as reportingRouter };
