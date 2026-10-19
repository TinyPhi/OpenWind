import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { deleteWorkflow, getWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";
import {
  assertMaySetActorRules,
  SodRuleForbiddenError,
} from "../../lib/sod-rule-gate.js";

export const deleteWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      await withTenantContext(tenantId, async (tx) => {
        const caller = toWorkflowCaller(auth);
        // Deleting the workflow deletes its transitions, and any actor rule with them.
        const current = await getWorkflow(tx, tenantId, id, caller);
        for (const t of current.transitions) {
          assertMaySetActorRules(auth, t.conditions, null);
        }
        await deleteWorkflow(tx, tenantId, id, caller);
      });
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof SodRuleForbiddenError) {
        return c.json({ error: "FORBIDDEN", message: err.message }, 403);
      }
      return handleWorkflowError(c, err);
    }
  },
);
