import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { createWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

const CreateWorkflowSchema = z.object({
  entityTypeId: z.string().uuid(),
  name: z.string().min(1).max(200),
  initialState: z.string().min(1).max(100),
});

export const createWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateWorkflowSchema),
  async (c) => {
    const input = c.req.valid("json");
    const { tenantId, userId } = c.get("auth");
    try {
      const workflow = await withTenantContext(tenantId, (tx) =>
        createWorkflow(tx, tenantId, userId, input),
      );
      return c.json({ data: workflow }, 201);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
