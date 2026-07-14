import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

export const getWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      const workflow = await withTenantContext(tenantId, (tx) =>
        getWorkflow(tx, tenantId, id, toWorkflowCaller(auth)),
      );
      return c.json({ data: workflow });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
