import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { deleteWorkflowState } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";

export const deleteStateHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const stateId = c.req.param("stateId") ?? "";
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      await withTenantContext(tenantId, (tx) =>
        deleteWorkflowState(
          tx,
          tenantId,
          workflowId,
          stateId,
          toWorkflowCaller(auth),
        ),
      );
      return c.body(null, 204);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
