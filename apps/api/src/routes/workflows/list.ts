import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { listWorkflows } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

const ListWorkflowsQuerySchema = z.object({
  entityTypeId: z.string().uuid(),
});

export const listWorkflowsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("query", ListWorkflowsQuerySchema),
  async (c) => {
    const { entityTypeId } = c.req.valid("query");
    const { tenantId } = c.get("auth");
    try {
      const workflows = await listWorkflows(db, tenantId, entityTypeId);
      return c.json({ data: workflows });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
