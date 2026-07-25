import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { createChildRelation } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { assertRecordWorkflowAccess } from "../../lib/assert-record-workflow-access.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

const CreateChildSchema = z.object({
  entityTypeId: z.string().uuid(),
  fields: z.record(z.unknown()).default({}),
  assignedTo: z.string().optional(),
});

export const createChildHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateChildSchema),
  async (c) => {
    const parentId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId, userId } = auth;
    // "agent" is a tenant-wide role that already creates sub-tickets under
    // any parent (matches the pre-existing requireRole("admin","agent")
    // contract); only "user" callers are subject to the extra per-workflow
    // admin check below.
    const isAgentOrAdmin =
      auth.roles.includes("admin") || auth.roles.includes("agent");
    const caller = toWorkflowCaller(auth);

    try {
      const result = await withTenantContext(tenantId, async (tx) => {
        if (!isAgentOrAdmin) {
          await assertRecordWorkflowAccess(tx, tenantId, parentId, caller);
        }
        return createChildRelation(tx, tenantId, {
          parentId,
          entityTypeId: input.entityTypeId,
          childFields: input.fields,
          assignedTo: input.assignedTo,
          createdBy: userId,
        });
      });
      return c.json({ data: result }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
