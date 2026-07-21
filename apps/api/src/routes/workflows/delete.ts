import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { deleteWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

export const deleteWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      await withTenantContext(tenantId, (tx) =>
        deleteWorkflow(tx, tenantId, id, toWorkflowCaller(auth)),
      );
      return c.body(null, 204);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
