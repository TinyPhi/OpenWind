import { Hono } from "hono";
import type { PlatformAdminAuthContext } from "@platform/auth";
import { sessionHandler } from "./session.js";
import { mfaRequestHandler, mfaVerifyHandler } from "./mfa.js";
import {
  createSandboxHandler,
  sandboxProgressHandler,
  sandboxHandoverHandler,
} from "./sandboxes.js";
import { sandboxResetHandler } from "./sandbox-reset.js";
import { sandboxDeleteHandler } from "./sandbox-delete.js";

const router = new Hono<{
  Variables: { platformAdmin: PlatformAdminAuthContext };
}>();

router.get("/session", ...sessionHandler);
router.post("/mfa/request", ...mfaRequestHandler);
router.post("/mfa/verify", ...mfaVerifyHandler);
router.post("/sandboxes", ...createSandboxHandler);
router.get("/sandboxes/:jobId/progress", ...sandboxProgressHandler);
router.get("/sandboxes/:jobId/handover", ...sandboxHandoverHandler);
router.post("/sandboxes/:tenantId/reset", ...sandboxResetHandler);
router.post("/sandboxes/:tenantId/delete", ...sandboxDeleteHandler);

export { router as platformAdminRouter };
