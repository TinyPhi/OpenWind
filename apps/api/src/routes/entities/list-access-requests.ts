import { eq, and } from "drizzle-orm";
import { requireAuth } from "@platform/auth";
import {
  entityInstances,
  accessRequests,
  withTenantContext,
} from "@platform/db";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

export const listAccessRequestsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId } = c.get("auth");

    try {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            createdBy: entityInstances.createdBy,
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

      // Only creator or assignee may see the access request list
      const isOwner =
        instance.createdBy === userId || instance.assignedTo === userId;
      if (!isOwner) {
        return c.json({ error: "FORBIDDEN", message: "Not found" }, 404);
      }

      const rows = await withTenantContext(tenantId, (tx) =>
        tx
          .select()
          .from(accessRequests)
          .where(
            and(
              eq(accessRequests.tenantId, tenantId),
              eq(accessRequests.instanceId, id),
            ),
          )
          .orderBy(accessRequests.createdAt),
      );

      return c.json({ data: rows });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
