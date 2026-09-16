/**
 * DELETE /entities/:id/labels/:labelId — remove a label from a ticket
 * (docs/specs/oncall-routing.md T38, R1c, spec §V: hard-delete, history
 * lives in the audit log via label.removed, not a deleted_at column on
 * ticket_labels itself).
 */

import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext, ticketLabels } from "@platform/db";
import { eq, and } from "drizzle-orm";
import { writeAuditEntry } from "@platform/audit";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";

export const deleteLabelHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent"),
  async (c) => {
    const ticketInstanceId = c.req.param("id") ?? "";
    const labelId = c.req.param("labelId") ?? "";
    const { tenantId, userId } = c.get("auth");

    try {
      const [row] = await withTenantContext(tenantId, async (tx) => {
        const [deleted] = await tx
          .delete(ticketLabels)
          .where(
            and(
              eq(ticketLabels.ticketInstanceId, ticketInstanceId),
              eq(ticketLabels.labelId, labelId),
              eq(ticketLabels.tenantId, tenantId),
            ),
          )
          .returning({
            ticketInstanceId: ticketLabels.ticketInstanceId,
            labelId: ticketLabels.labelId,
          });
        if (deleted) {
          await writeAuditEntry(tx, {
            tenantId,
            actorId: userId,
            actorType: "user",
            resourceType: "ticket_label",
            resourceId: `${deleted.ticketInstanceId}:${deleted.labelId}`,
            action: "label.removed",
            beforeSnapshot: {
              ticketInstanceId: deleted.ticketInstanceId,
              labelId: deleted.labelId,
            },
          });
        }
        return [deleted] as const;
      });

      if (!row) {
        return c.json(
          { error: "NOT_FOUND", message: "Label assignment not found" },
          404,
        );
      }
      return c.body(null, 204);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
