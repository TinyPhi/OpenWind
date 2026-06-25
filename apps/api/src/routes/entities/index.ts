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

const router = new Hono<{ Variables: { auth: AuthContext } }>();

// Static routes before dynamic /:id to avoid shadowing
router.get("/", ...listEntitiesHandler);
router.post("/", ...createEntityHandler);
router.get("/search", ...searchEntitiesHandler);

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

export { router as entitiesRouter };
