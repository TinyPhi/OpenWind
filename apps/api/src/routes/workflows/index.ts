import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";
import { createWorkflowHandler } from "./create.js";
import { listWorkflowsHandler } from "./list.js";
import { getWorkflowHandler } from "./get.js";
import { deleteWorkflowHandler } from "./delete.js";
import { createStateHandler } from "./states/create-state.js";
import { updateStateHandler } from "./states/update-state.js";
import { deleteStateHandler } from "./states/delete-state.js";
import { createTransitionHandler } from "./transitions/create-transition.js";
import { updateTransitionHandler } from "./transitions/update-transition.js";
import { deleteTransitionHandler } from "./transitions/delete-transition.js";

const router = new Hono<{ Variables: { auth: AuthContext } }>();

router.post("/", ...createWorkflowHandler);
router.get("/", ...listWorkflowsHandler);
router.get("/:id", ...getWorkflowHandler);
router.delete("/:id", ...deleteWorkflowHandler);

router.post("/:id/states", ...createStateHandler);
router.patch("/:id/states/:stateId", ...updateStateHandler);
router.delete("/:id/states/:stateId", ...deleteStateHandler);

router.post("/:id/transitions", ...createTransitionHandler);
router.patch("/:id/transitions/:transitionId", ...updateTransitionHandler);
router.delete("/:id/transitions/:transitionId", ...deleteTransitionHandler);

export { router as workflowsRouter };
