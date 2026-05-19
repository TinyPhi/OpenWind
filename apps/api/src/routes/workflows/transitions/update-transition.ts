import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { db } from "@platform/db";
import { updateWorkflowTransition } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";

const UpdateTransitionSchema = z.object({
  label: z.string().max(200).nullable().optional(),
  allowedRoles: z.array(z.string()).optional(),
  conditions: z.unknown().optional(),
  requiresComment: z.boolean().optional(),
  requiresFields: z.array(z.string()).optional(),
});

export const updateTransitionHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin"),
  zValidator("json", UpdateTransitionSchema),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const transitionId = c.req.param("transitionId") ?? "";
    const input = c.req.valid("json");
    const { tenantId } = c.get("auth");
    try {
      const transition = await updateWorkflowTransition(
        db,
        tenantId,
        workflowId,
        transitionId,
        {
          label: input.label ?? undefined,
          allowedRoles: input.allowedRoles,
          conditions: input.conditions as never,
          requiresComment: input.requiresComment,
          requiresFields: input.requiresFields,
        },
      );
      return c.json({ data: transition });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
