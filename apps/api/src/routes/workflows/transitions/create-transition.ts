import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { addWorkflowTransition } from "@platform/workflow-engine";
import { factory } from "../factory.js";
import { handleWorkflowError } from "../../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../../lib/workflow-caller.js";

const CreateTransitionSchema = z.object({
  fromState: z.string().min(1).max(100),
  toState: z.string().min(1).max(100),
  label: z.string().max(200).optional(),
  allowedRoles: z.array(z.string()).optional(),
  conditions: z.unknown().optional(),
  requiresComment: z.boolean().optional(),
  requiresFields: z.array(z.string()).optional(),
});

export const createTransitionHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateTransitionSchema),
  async (c) => {
    const workflowId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId } = auth;
    try {
      const transition = await withTenantContext(tenantId, (tx) =>
        addWorkflowTransition(
          tx,
          tenantId,
          workflowId,
          toWorkflowCaller(auth),
          {
            fromState: input.fromState,
            toState: input.toState,
            label: input.label,
            allowedRoles: input.allowedRoles,
            conditions: input.conditions as never,
            requiresComment: input.requiresComment,
            requiresFields: input.requiresFields,
          },
        ),
      );
      return c.json({ data: transition }, 201);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
