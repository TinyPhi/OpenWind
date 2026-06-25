import { requireAuth } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

export const getWorkflowHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    try {
      const workflow = await withTenantContext(tenantId, (tx) =>
        getWorkflow(tx, tenantId, id),
      );
      // Admins and agents have full access; regular users may only access
      // workflows they are assigned to. Return 404 (not 403) to avoid leaking existence.
      const isPrivileged = roles.includes("admin") || roles.includes("agent");
      const isAssignee = workflow.assignedTo === userId;
      if (!isPrivileged && !isAssignee) {
        return c.json(
          { error: "NOT_FOUND", message: "Workflow not found" },
          404,
        );
      }
      return c.json({ data: workflow });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
