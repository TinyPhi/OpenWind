import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { createEntityHandler } from "./create.js";
import { getEntityHandler } from "./get.js";
import { updateEntityHandler } from "./update.js";
import { deleteEntityHandler } from "./delete.js";
import { listEntitiesHandler } from "./list.js";
import { setEntityStateHandler } from "./set-state.js";
import { createRelationHandler } from "./create-relation.js";
import { listRelationsHandler } from "./list-relations.js";
import { deleteRelationHandler } from "./delete-relation.js";
import { searchEntitiesHandler } from "./search.js";
import { bulkCreateHandler } from "./bulk-create.js";
import { bulkUpdateHandler } from "./bulk-update.js";
import { bulkSetStateHandler } from "./bulk-set-state.js";
import { executeTransitionHandler } from "./execute-transition.js";
import { listTransitionsHandler } from "./list-transitions.js";
import { listWorkflowEventsHandler } from "./list-workflow-events.js";
import { listEventsHandler } from "./list-events.js";
import { addCommentHandler } from "./add-comment.js";
import { createChildHandler } from "./create-child.js";
import { listChildrenHandler } from "./list-children.js";
import { moveParentHandler } from "./move-parent.js";
import { setChildStatusHandler } from "./set-child-status.js";
import { archiveEntityHandler } from "./archive.js";
import { restoreEntityHandler } from "./restore.js";
import { getAccessHandler } from "./get-access.js";
import { grantAccessHandler } from "./grant-access.js";
import { revokeAccessHandler } from "./revoke-access.js";
import { updateAccessHandler } from "./update-access.js";
import { myTicketsHandler } from "./my-tickets.js";
import { requestAccessHandler } from "./request-access.js";
import { listAccessRequestsHandler } from "./list-access-requests.js";
import { resolveAccessRequestHandler } from "./resolve-access-request.js";
import { listAttachmentsHandler } from "./list-attachments.js";
import { createAttachmentHandler } from "./create-attachment.js";
import { deleteAttachmentHandler } from "./delete-attachment.js";
import { addCommentAttachmentHandler } from "./add-comment-attachment.js";
import { deleteCommentAttachmentHandler } from "./delete-comment-attachment.js";
import { createAlertHandler } from "./create-alert.js";
import { listAlertsHandler } from "./list-alerts.js";
import { updateAlertHandler } from "./update-alert.js";
import { deleteAlertHandler } from "./delete-alert.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

// Static routes before dynamic /:id to avoid shadowing
router.get("/", ...listEntitiesHandler);
router.post("/", ...createEntityHandler);
router.get("/search", ...searchEntitiesHandler);
router.get("/my-tickets", ...myTicketsHandler);

// Bulk routes — rate-limited to 10 req/min at the gateway layer
router.post("/bulk", ...bulkCreateHandler);
router.patch("/bulk", ...bulkUpdateHandler);
router.post("/bulk/state", ...bulkSetStateHandler);

router.get("/:id", ...getEntityHandler);
router.patch("/:id", ...updateEntityHandler);
router.delete("/:id", ...deleteEntityHandler);
router.post("/:id/state", ...setEntityStateHandler);

// Workflow transition routes — history must be registered before the bare transitions route
router.get("/:id/transitions/history", ...listWorkflowEventsHandler);
router.get("/:id/transitions", ...listTransitionsHandler);
router.post("/:id/transitions", ...executeTransitionHandler);

router.get("/:id/events", ...listEventsHandler);
router.post("/:id/comments", ...addCommentHandler);

router.post("/:id/relations", ...createRelationHandler);
router.get("/:id/relations", ...listRelationsHandler);
router.delete("/:id/relations/:relationId", ...deleteRelationHandler);

router.post("/:id/children", ...createChildHandler);
router.get("/:id/children", ...listChildrenHandler);
router.patch("/:id/parent", ...moveParentHandler);
router.patch("/:id/child-status", ...setChildStatusHandler);
router.post("/:id/archive", ...archiveEntityHandler);
router.post("/:id/restore", ...restoreEntityHandler);

router.get("/:id/access", ...getAccessHandler);
router.post("/:id/access", ...grantAccessHandler);
router.patch("/:id/access/:userId", ...updateAccessHandler);
router.delete("/:id/access/:userId", ...revokeAccessHandler);

router.post("/:id/access-requests", ...requestAccessHandler);
router.get("/:id/access-requests", ...listAccessRequestsHandler);
router.patch("/:id/access-requests/:reqId", ...resolveAccessRequestHandler);

router.get("/:id/attachments", ...listAttachmentsHandler);
router.post("/:id/attachments", ...createAttachmentHandler);
router.delete("/:id/attachments/:fileId", ...deleteAttachmentHandler);

router.post("/:id/alerts", ...createAlertHandler);
router.get("/:id/alerts", ...listAlertsHandler);
router.patch("/:id/alerts/:alertId", ...updateAlertHandler);
router.delete("/:id/alerts/:alertId", ...deleteAlertHandler);

router.post(
  "/:id/comments/:eventId/attachments",
  ...addCommentAttachmentHandler,
);
router.delete(
  "/:id/comments/:eventId/attachments/:fileId",
  ...deleteCommentAttachmentHandler,
);

export { router as entitiesRouter };
