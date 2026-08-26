import { Hono } from "hono";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { listThirdPartyWorkflowsHandler } from "./workflows.js";
import {
  getThirdPartyTicketHandler,
  createThirdPartyTicketHandler,
} from "./tickets.js";
import { executeThirdPartyTransitionHandler } from "./transitions.js";
import { createThirdPartyChildHandler } from "./children.js";
import { createThirdPartyCommentHandler } from "./comments.js";
import { presignAttachmentHandler } from "./attachments-presign.js";
import { uploadAttachmentHandler } from "./attachments-upload.js";
import { downloadAttachmentHandler } from "./attachments-download.js";

const router = new Hono<{
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
}>();

router.get("/workflows", ...listThirdPartyWorkflowsHandler);
router.post("/tickets", ...createThirdPartyTicketHandler);
router.get("/tickets/:id", ...getThirdPartyTicketHandler);
router.post("/tickets/:id/transitions", ...executeThirdPartyTransitionHandler);
router.post("/tickets/:id/comments", ...createThirdPartyCommentHandler);
router.post("/tickets/:id/children", ...createThirdPartyChildHandler);
router.post("/attachments/presign", ...presignAttachmentHandler);
router.put("/attachments/:id/upload", ...uploadAttachmentHandler);
router.get("/attachments/:id/download", ...downloadAttachmentHandler);

export { router as thirdPartyRouter };
