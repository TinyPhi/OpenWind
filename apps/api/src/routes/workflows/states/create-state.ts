import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { addWorkflowState } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";

const CreateStateSchema = z.object({
  name: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  color: z.string().optional(),
  isTerminal: z.boolean().optional(),
  slaHours: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const createStateHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateStateSchema),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      const state = await withTenantContext(tenantId, (tx) =>
        addWorkflowState(
          tx,
          tenantId,
          workflowId,
          toWorkflowCaller(auth),
          input,
        ),
      );
      return c.json({ data: state }, 201);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
