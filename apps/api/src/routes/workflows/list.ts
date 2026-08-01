import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { listWorkflows, listWorkflowsSummary } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

const ListWorkflowsQuerySchema = z.object({
  entityTypeId: z.string().uuid().optional(),
  activeOnly: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  summary: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listWorkflowsHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("query", ListWorkflowsQuerySchema),
  async (c) => {
    const { entityTypeId, activeOnly, summary, limit, offset } =
      c.req.valid("query");
    const auth = c.get("auth");
    const { tenantId } = auth;
    const caller = toWorkflowCaller(auth);
    try {
      const workflows = await withTenantContext(tenantId, (tx) =>
        summary
          ? listWorkflowsSummary(
              tx,
              tenantId,
              caller,
              entityTypeId,
              activeOnly,
              limit,
              offset,
            )
          : listWorkflows(
              tx,
              tenantId,
              caller,
              entityTypeId,
              activeOnly,
              limit,
              offset,
            ),
      );
      return c.json({ data: workflows });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
