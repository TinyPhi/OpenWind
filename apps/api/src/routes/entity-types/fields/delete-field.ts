import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { deleteEntityField } from "@platform/entity-engine";
import { factory } from "../factory.js";
import { handleEntityError } from "../../../lib/handle-entity-error.js";
import { assertFieldWorkflowAccess } from "../../../lib/assert-field-workflow-access.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";

export const deleteEntityFieldHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const typeId = c.get("typeId");
    const fieldId = c.req.param("fieldId") ?? "";
    const auth = c.get("auth");
    const { tenantId } = auth;
    const caller = toWorkflowCaller(auth);

    try {
      await withTenantContext(tenantId, async (tx) => {
        await assertFieldWorkflowAccess(tx, tenantId, typeId, caller);
        await deleteEntityField(tx, tenantId, typeId, fieldId);
      });
      return c.body(null, 204);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
