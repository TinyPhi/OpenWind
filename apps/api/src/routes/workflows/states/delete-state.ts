import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { deleteWorkflowState } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";

export const deleteStateHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const stateId = c.req.param("stateId") ?? "";
    const { tenantId } = c.get("auth");
    try {
      await deleteWorkflowState(db, tenantId, workflowId, stateId);
      return c.body(null, 204);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
