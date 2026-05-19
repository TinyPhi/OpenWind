import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { updateWorkflowState } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";

const UpdateStateSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  color: z.string().optional(),
  isTerminal: z.boolean().optional(),
  slaHours: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

export const updateStateHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", UpdateStateSchema),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const stateId = c.req.param("stateId") ?? "";
    const input = c.req.valid("json");
    const { tenantId } = c.get("auth");
    try {
      const state = await updateWorkflowState(
        db,
        tenantId,
        workflowId,
        stateId,
        input,
      );
      return c.json({ data: state });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
