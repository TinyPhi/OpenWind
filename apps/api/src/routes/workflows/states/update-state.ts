import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { updateWorkflowState } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";

const UpdateStateSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  color: z.string().optional(),
  isTerminal: z.boolean().optional(),
  slaHours: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const updateStateHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", UpdateStateSchema),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const stateId = c.req.param("stateId") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      const state = await withTenantContext(tenantId, (tx) =>
        updateWorkflowState(
          tx,
          tenantId,
          workflowId,
          stateId,
          toWorkflowCaller(auth),
          input,
        ),
      );
      return c.json({ data: state });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
