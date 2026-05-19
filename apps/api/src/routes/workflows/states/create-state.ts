import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { addWorkflowState } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";

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
  requireRole("admin"),
  zValidator("json", CreateStateSchema),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const { tenantId } = c.get("auth");
    try {
      const state = await addWorkflowState(db, tenantId, workflowId, input);
      return c.json({ data: state }, 201);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
