import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { deleteWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

export const deleteWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
    try {
      await deleteWorkflow(db, tenantId, id);
      return c.body(null, 204);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
