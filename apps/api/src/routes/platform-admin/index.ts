import { Hono } from "hono";
import type { PlatformAdminAuthContext } from "@platform/auth";
import { sessionHandler } from "./session.js";
import { mfaRequestHandler, mfaVerifyHandler, mfaEndHandler } from "./mfa.js";
import {
  createSandboxHandler,
  sandboxProgressHandler,
  sandboxHandoverHandler,
} from "./sandboxes.js";
import { sandboxListHandler, sandboxDetailHandler } from "./sandboxes-list.js";
import {
  sandboxTrialHandler,
  sandboxTrialEndHandler,
} from "./sandbox-trial.js";
import { sandboxResetHandler } from "./sandbox-reset.js";
import { sandboxDeleteHandler } from "./sandbox-delete.js";
import { sandboxOrgTreeHandler } from "./sandbox-org-tree.js";
import { auditLogHandler } from "./audit-log.js";

const router = new Hono<{
  Variables: { platformAdmin: PlatformAdminAuthContext };
}>();

router.get("/session", ...sessionHandler);
router.post("/mfa/request", ...mfaRequestHandler);
router.post("/mfa/verify", ...mfaVerifyHandler);
router.post("/mfa/end", ...mfaEndHandler);
router.post("/sandboxes", ...createSandboxHandler);
router.get("/sandboxes", ...sandboxListHandler);
router.get("/sandboxes/:tenantId", ...sandboxDetailHandler);
router.get("/sandboxes/:jobId/progress", ...sandboxProgressHandler);
router.get("/sandboxes/:jobId/handover", ...sandboxHandoverHandler);
router.post("/sandboxes/:tenantId/reset", ...sandboxResetHandler);
router.post("/sandboxes/:tenantId/delete", ...sandboxDeleteHandler);
router.post("/sandboxes/:tenantId/seed-org-tree", ...sandboxOrgTreeHandler);
router.post("/sandboxes/:tenantId/trial", ...sandboxTrialHandler);
router.post("/sandboxes/:tenantId/trial/end", ...sandboxTrialEndHandler);
router.get("/audit-log", ...auditLogHandler);

export { router as platformAdminRouter };
