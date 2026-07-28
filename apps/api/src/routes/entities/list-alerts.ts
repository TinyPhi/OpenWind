import { requireAuth } from "@platform/auth";
import { eq, and, or } from "drizzle-orm";
import { entityInstances, ticketAlerts, withTenantContext } from "@platform/db";
import { factory } from "./factory.js";
import { hasEntityReadAccess } from "../../lib/entity-access.js";

export const listAlertsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    const result = await withTenantContext(tenantId, async (tx) => {
      const [instance] = await tx
        .select({
          createdBy: entityInstances.createdBy,
          assignedTo: entityInstances.assignedTo,
          fields: entityInstances.fields,
        })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, instanceId),
            eq(entityInstances.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!instance) return { status: 404 as const };
      if (!hasEntityReadAccess(instance, userId, roles)) {
        return { status: 404 as const };
      }

      // Visibility (§R2): creator always sees their own; scope='all' alerts
      // are visible to anyone who reaches this point (they already have
      // ticket access, checked above). scope='me' alerts from other users
      // are never included — omitted by this filter, not merely hidden.
      const rows = await tx
        .select()
        .from(ticketAlerts)
        .where(
          and(
            eq(ticketAlerts.tenantId, tenantId),
            eq(ticketAlerts.instanceId, instanceId),
            or(
              eq(ticketAlerts.createdBy, userId),
              eq(ticketAlerts.scope, "all"),
            ),
          ),
        )
        .orderBy(ticketAlerts.fireAt);

      return { status: 200 as const, rows };
    });

    if (result.status === 404) {
      return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
    }
    return c.json({ data: result.rows });
  },
);
