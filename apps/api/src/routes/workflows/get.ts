import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { getWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

// Deliberately not ownership-filtered, mirroring getWorkflow's own design
// intent (packages/workflow-engine/src/workflow-crud.ts): states/transitions/
// createdBy/assignedTo carry no secrets, so every tenant member with role
// admin/agent/user can read a workflow's definition — including a member who
// owns zero tickets in it yet, which the records page (workflow-records.tsx)
// needs to render its empty state and let the caller create their first
// ticket. Per-workflow ownership (createdBy/assignedTo) still gates
// *mutating* a workflow's settings (assertWorkflowOwned in workflow-crud.ts)
// and the admin-ui settings page gates itself client-side off the same
// createdBy/assignedTo fields returned here. Cross-tenant/nonexistent ids
// still 404 via getWorkflow's own tenant-scoped not-found throw.
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
