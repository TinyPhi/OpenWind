import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { executeTransition } from "@platform/workflow-engine";
import type { TransitionRequest } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

const ExecuteTransitionSchema = z.object({
  transitionId: z.string().uuid(),
  comment: z.string().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const executeTransitionHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", ExecuteTransitionSchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const { transitionId, comment, idempotencyKey, metadata } =
      c.req.valid("json");

    try {
      const request: TransitionRequest = {
        instanceId,
        transitionId,
        actorId: userId,
        actorRoles: roles,
        triggeredBy: "user",
        ...(comment !== undefined && { comment }),
        ...(idempotencyKey !== undefined && { idempotencyKey }),
        ...(metadata !== undefined && { metadata }),
      };

      const event = await withTenantContext(tenantId, (tx) =>
        executeTransition(tx, tenantId, request),
      );

      return c.json({ data: event }, 201);
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
