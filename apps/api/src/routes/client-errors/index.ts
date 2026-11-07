import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { reportClientErrorHandler } from "./report.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.post("/", ...reportClientErrorHandler);

export { router as clientErrorsRouter };
