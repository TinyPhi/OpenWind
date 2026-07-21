import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { deleteWorkflowTransition } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";

export const deleteTransitionHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const transitionId = c.req.param("transitionId") ?? "";
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      await withTenantContext(tenantId, (tx) =>
        deleteWorkflowTransition(
          tx,
          tenantId,
          workflowId,
          transitionId,
          toWorkflowCaller(auth),
        ),
      );
      return c.body(null, 204);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
