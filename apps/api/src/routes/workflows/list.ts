import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { listWorkflows } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

const ListWorkflowsQuerySchema = z.object({
  entityTypeId: z.string().uuid().optional(),
  activeOnly: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export const listWorkflowsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("query", ListWorkflowsQuerySchema),
  async (c) => {
    const { entityTypeId, activeOnly } = c.req.valid("query");
    const { tenantId } = c.get("auth");
    try {
      const workflows = await withTenantContext(tenantId, (tx) =>
        listWorkflows(tx, tenantId, entityTypeId, activeOnly),
      );
      return c.json({ data: workflows });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
