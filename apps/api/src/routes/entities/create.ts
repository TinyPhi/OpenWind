import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { tenantUsers, withTenantContext } from "@platform/db";
import { createEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const CreateEntitySchema = z.object({
  entityTypeId: z.string().uuid(),
  fields: z.record(z.unknown()),
  createdBy: z.string().optional(),
  assignedTo: z.string().optional(),
  workflowId: z.string().uuid().optional(),
  currentState: z.string().optional(),
});

export const createEntityHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("json", CreateEntitySchema),
  async (c) => {
    const { tenantId, userId } = c.get("auth");
    const input = c.req.valid("json");

    try {
      const [dbUser] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            displayName: tenantUsers.displayName,
            email: tenantUsers.email,
          })
          .from(tenantUsers)
          .where(
            and(
              eq(tenantUsers.userId, userId),
              eq(tenantUsers.tenantId, tenantId),
            ),
          )
          .limit(1),
      );
      const actorName =
        dbUser?.displayName && dbUser.displayName !== userId
          ? dbUser.displayName
          : dbUser?.email && dbUser.email !== userId
            ? dbUser.email
            : null;

      const instance = await withTenantContext(tenantId, (tx) =>
        createEntity(tx, tenantId, {
          ...input,
          actorId: userId,
          actorName: actorName ?? undefined,
          // Prefer createdBy from body if provided; fall back to authenticated user.
          createdBy: input.createdBy ?? userId,
        }),
      );
      return c.json({ data: instance }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
