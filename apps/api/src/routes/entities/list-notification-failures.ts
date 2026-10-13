import { requireAuth, requireRole } from "@platform/auth";
import { queryAuditLog } from "@platform/audit";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { entityInstances, withTenantContext } from "@platform/db";
import { factory } from "./factory.js";
import { zValidator } from "../../lib/validator.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

const ParamsSchema = z.object({ id: z.string().uuid() });

export const NOTIFICATION_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_FAILURES = 50;

// Deliberately returns only the channel and the time. The audit entry's
// errorSummary can carry provider error text, which staff do not need here;
// it stays in the admin-only audit log.
export const listNotificationFailuresHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  zValidator("param", ParamsSchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { tenantId, userId, roles } = c.get("auth");

    try {
      const result = await withTenantContext(tenantId, async (tx) => {
        const [row] = await tx
          .select({
            fields: entityInstances.fields,
            assignedTo: entityInstances.assignedTo,
            createdBy: entityInstances.createdBy,
            workflowId: entityInstances.workflowId,
          })
          .from(entityInstances)
          .where(
            and(
              eq(entityInstances.id, id),
              eq(entityInstances.tenantId, tenantId),
            ),
          )
          .limit(1);
        if (!row || !(await hasEntityAccess(tx, tenantId, row, userId, roles)))
          return null;

        // resourceType is passed so the (tenant, resource_type, resource_id)
        // index serves the lookup.
        return queryAuditLog(tx, {
          tenantId,
          action: "notification.channel_failed",
          resourceType: "ticket",
          resourceId: id,
          from: new Date(Date.now() - NOTIFICATION_FAILURE_WINDOW_MS),
          limit: MAX_FAILURES,
        });
      });

      if (!result) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      return c.json({
        data: {
          failures: result.entries.map((e) => ({
            channel:
              typeof e.metadata?.channel === "string"
                ? e.metadata.channel
                : "unknown",
            occurredAt: e.createdAt,
          })),
        },
      });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
