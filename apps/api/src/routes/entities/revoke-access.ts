import { eq, and, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { entityInstances, withTenantContext } from "@platform/db";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { emitAccessEvent } from "../../lib/emit-access-event.js";

export const revokeAccessHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const targetUserId = c.req.param("userId") ?? "";
    const { tenantId, userId: actorId } = c.get("auth");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: entityInstances.id,
            assignedTo: entityInstances.assignedTo,
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

      if (!instance) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      // Remove key from the __accessUsers object map using the - operator
      await withTenantContext(tenantId, (tx) =>
        tx
          .update(entityInstances)
          .set({
            fields: sql`jsonb_set(
              fields,
              '{__accessUsers}',
              COALESCE(fields->'__accessUsers', '{}') - ${targetUserId}
            )`,
            ...(instance.assignedTo === targetUserId
              ? { assignedTo: sql`NULL` }
              : {}),
          })
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          ),
      );

      void emitAccessEvent(tenantId, id, actorId, {
        type: "access_revoke",
        targetUserId,
      });

      return c.json({ data: { revoked: true } });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
