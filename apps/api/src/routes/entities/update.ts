import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@platform/auth";
import { entityInstances, tenantUsers, withTenantContext } from "@platform/db";
import { updateEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

const UpdateEntitySchema = z.object({
  fields: z.record(z.unknown()).optional(),
  assignedTo: z.string().nullable().optional(),
  currentState: z.string().optional(),
});

export const updateEntityHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", UpdateEntitySchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const input = c.req.valid("json");

    const isAdminOrAgent = roles.includes("admin") || roles.includes("agent");

    // Non-admin/agent users may only edit records they own (assignee or creator)
    if (!isAdminOrAgent) {
      const [row] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            assignedTo: entityInstances.assignedTo,
            createdBy: entityInstances.createdBy,
          })
          .from(entityInstances)
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .limit(1),
      );

      if (row?.assignedTo !== userId && row?.createdBy !== userId) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }
    }

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
        updateEntity(tx, tenantId, id, {
          ...input,
          actorId: userId,
          actorType: "user",
          actorName: actorName ?? undefined,
        }),
      );
      return c.json({ data: instance });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);

export const updateEntityUserHandler = updateEntityHandler;
