import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import { ticketAlerts, withTenantContext } from "@platform/db";
import { factory } from "./factory.js";
import { voidPendingAlertOutboxRows } from "../../lib/alert-outbox.js";
import {
  ticketAlertsQueue,
  ticketAlertJobId,
} from "../../lib/ticket-alerts-queue.js";

export const deleteAlertHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const alertId = c.req.param("alertId") ?? "";
    const { tenantId, userId } = c.get("auth");

    const result = await withTenantContext(tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(ticketAlerts)
        .where(
          and(
            eq(ticketAlerts.id, alertId),
            eq(ticketAlerts.instanceId, instanceId),
            eq(ticketAlerts.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!existing) return { status: 404 as const };
      if (existing.createdBy !== userId) {
        return existing.scope === "all"
          ? { status: 403 as const }
          : { status: 404 as const };
      }
      if (existing.status !== "pending") {
        return { status: 409 as const };
      }

      await tx
        .update(ticketAlerts)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(ticketAlerts.id, alertId),
            eq(ticketAlerts.tenantId, tenantId),
          ),
        );

      // Not load-bearing (alert-worker's status guard already prevents a
      // cancelled alert from firing) — voids a not-yet-polled outbox row so
      // it doesn't sit around getting "enqueued" for a job that'll just
      // no-op, and the scheduler's log stays meaningful.
      await voidPendingAlertOutboxRows(tx, alertId);

      return { status: 204 as const };
    });

    if (result.status === 404) {
      return c.json({ error: "NOT_FOUND", message: "Alert not found" }, 404);
    }
    if (result.status === 403) {
      return c.json(
        { error: "FORBIDDEN", message: "Not the alert creator" },
        403,
      );
    }
    if (result.status === 409) {
      return c.json(
        {
          error: "ALERT_NOT_PENDING",
          message: "Alert already fired or cancelled",
        },
        409,
      );
    }

    // Only remove the job once ownership+status passed — see update-alert.ts
    // for why this must not happen before the authorization check.
    await ticketAlertsQueue.remove(ticketAlertJobId(alertId));

    return c.body(null, 204);
  },
);
