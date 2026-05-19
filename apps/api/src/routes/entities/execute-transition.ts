import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import { executeTransition } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";

const ExecuteTransitionSchema = z.object({
  transitionId: z.string().min(1),
  comment: z.string().optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const executeTransitionHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("json", ExecuteTransitionSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const { transitionId, comment, idempotencyKey, metadata } =
      c.req.valid("json");

    try {
      const event = await withTenantContext(tenantId, (tx) =>
        executeTransition(tx, tenantId, {
          instanceId: id,
          transitionId,
          actorId: userId,
          actorRoles: roles,
          triggeredBy: "user",
          ...(comment !== undefined ? { comment } : {}),
          ...(metadata !== undefined || idempotencyKey !== undefined
            ? {
                metadata: {
                  ...metadata,
                  ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
                },
              }
            : {}),
        }),
      );

      return c.json({ data: event });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
