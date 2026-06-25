import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext, tenantUsers } from "@platform/db";
import { eq, and } from "drizzle-orm";
import { updateWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

const UpdateWorkflowSchema = z.object({
  isActive: z.boolean().optional(),
  assignedTo: z.string().nullable().optional(),
});

export const updateWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", UpdateWorkflowSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
    const input = c.req.valid("json");

    // M2: verify assignedTo belongs to this tenant before writing
    if (input.assignedTo !== null && input.assignedTo !== undefined) {
      const [found] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ userId: tenantUsers.userId })
          .from(tenantUsers)
          .where(
            and(
              eq(tenantUsers.tenantId, tenantId),
              eq(tenantUsers.userId, input.assignedTo as string),
            ),
          )
          .limit(1),
      );
      if (!found)
        return c.json(
          { error: "NOT_FOUND", message: "User not found in this tenant" },
          404,
        );
    }

    try {
      const workflow = await withTenantContext(tenantId, (tx) =>
        updateWorkflow(tx, tenantId, id, input),
      );
      return c.json({ data: workflow });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
