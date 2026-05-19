import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { db, withTenantContext } from "@platform/db";
import { executeTransition } from "@platform/workflow-engine";
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
  requireRole("admin", "agent"),
  zValidator("json", ExecuteTransitionSchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const { transitionId, comment, idempotencyKey, metadata } =
      c.req.valid("json");

    try {
      const event = await withTenantContext(tenantId, (tx) =>
        executeTransition(tx, tenantId, {
          instanceId,
          transitionId,
          actorId: userId,
          actorRoles: roles,
          comment,
          idempotencyKey,
          metadata,
          triggeredBy: "user",
        }),
      );
      return c.json({ data: event });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
