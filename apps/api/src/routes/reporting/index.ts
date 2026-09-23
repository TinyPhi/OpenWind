import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { guestTokenHandler } from "./guest-token.js";
import { executeBYOQueryHandler } from "./query.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.get("/guest-token", ...guestTokenHandler);
router.post("/query", ...executeBYOQueryHandler);

export { router as reportingRouter };
