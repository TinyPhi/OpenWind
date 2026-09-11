/**
 * GET /entities/:id/labels — list labels assigned to a ticket
 * (docs/specs/oncall-routing.md T38, R1c). Same hasEntityAccess gate
 * list-relations.ts applies -- without it, any tenant member could enumerate
 * a ticket's labels by guessing its ID.
 */

import { requireAuth } from "@platform/auth";
import { withTenantContext, labels, ticketLabels } from "@platform/db";
import { eq, and, isNull } from "drizzle-orm";
import { getEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

export const listLabelsHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const ticketInstanceId = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    try {
      const instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, ticketInstanceId),
      );

      const allowed = await withTenantContext(tenantId, (tx) =>
        hasEntityAccess(tx, tenantId, instance, userId, roles),
      );
      if (!allowed) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      const rows = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            labelId: labels.id,
            name: labels.name,
            color: labels.color,
            description: labels.description,
            assignedBy: ticketLabels.assignedBy,
            assignedAt: ticketLabels.assignedAt,
          })
          .from(ticketLabels)
          .innerJoin(
            labels,
            and(
              eq(ticketLabels.labelId, labels.id),
              eq(labels.tenantId, tenantId),
              isNull(labels.deletedAt),
            ),
          )
          .where(
            and(
              eq(ticketLabels.ticketInstanceId, ticketInstanceId),
              eq(ticketLabels.tenantId, tenantId),
            ),
          ),
      );

      return c.json({ data: rows });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
