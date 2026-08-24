import { Hono } from "hono";
import type { AuthContext, ActingPersonContext } from "@platform/auth";
import { listThirdPartyWorkflowsHandler } from "./workflows.js";
import {
  getThirdPartyTicketHandler,
  createThirdPartyTicketHandler,
} from "./tickets.js";
import { createThirdPartyChildHandler } from "./children.js";
import { createThirdPartyCommentHandler } from "./comments.js";

const router = new Hono<{
  Variables: { auth: AuthContext; actingPerson: ActingPersonContext };
}>();

router.get("/workflows", ...listThirdPartyWorkflowsHandler);
router.post("/tickets", ...createThirdPartyTicketHandler);
router.get("/tickets/:id", ...getThirdPartyTicketHandler);
router.post("/tickets/:id/comments", ...createThirdPartyCommentHandler);
router.post("/tickets/:id/children", ...createThirdPartyChildHandler);

export { router as thirdPartyRouter };
