import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext, tenantUsers } from "@platform/db";
import { eq, and, inArray } from "drizzle-orm";
import { updateWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

const UpdateWorkflowSchema = z.object({
  isActive: z.boolean().optional(),
  assignedTo: z.array(z.string()).optional(),
  maxChildDepth: z.number().int().min(0).max(10).nullable().optional(),
  maxChildrenPerParent: z.number().int().min(1).max(100).nullable().optional(),
  initialState: z.string().min(1).max(100).optional(),
});

export const updateWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", UpdateWorkflowSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const auth = c.get("auth");
    const { tenantId } = auth;
    const input = c.req.valid("json");

    // Verify every workflow-admin user id belongs to this tenant before writing.
    // assignedTo here is the workflow-admins array (see migration
    // 0025_workflow_admins_array.sql) — not a single assignee, so each id in
    // the array must be checked individually via inArray, not eq.
    if (input.assignedTo !== undefined && input.assignedTo.length > 0) {
      const found = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ userId: tenantUsers.userId })
          .from(tenantUsers)
          .where(
            and(
              eq(tenantUsers.tenantId, tenantId),
              inArray(tenantUsers.userId, input.assignedTo as string[]),
            ),
          ),
      );
      const foundIds = new Set(found.map((f) => f.userId));
      const missing = input.assignedTo.filter((id) => !foundIds.has(id));
      if (missing.length > 0)
        return c.json(
          {
            error: "NOT_FOUND",
            message: "One or more users not found in this tenant",
          },
          404,
        );
    }

    try {
      const workflow = await withTenantContext(tenantId, (tx) =>
        updateWorkflow(tx, tenantId, id, toWorkflowCaller(auth), input),
      );
      return c.json({ data: workflow });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
