import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

// Reading a workflow's definition (states/transitions) is tenant-wide for
// every authenticated member, matching GET /workflows (the list endpoint) —
// any tenant user can browse a workflow they haven't touched yet, e.g. to
// create their first ticket in it. Ownership (createdBy/assignedTo[]) gates
// *mutating* workflow settings (updateWorkflow/deleteWorkflow), not reading
// the definition. getWorkflow itself still 404s for a genuinely nonexistent
// or cross-tenant workflow id.
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
