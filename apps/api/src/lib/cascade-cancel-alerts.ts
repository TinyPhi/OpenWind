/**
 * Cascade-cancel hooks for ticket_alerts (docs/specs/ticket-alerts.md §R8).
 * Best-effort, mirrors emit-access-event.ts's philosophy: never block or fail
 * the primary operation (archive/delete/revoke) if cancellation has trouble —
 * an alert firing a little late for an archived/inaccessible ticket is a far
 * smaller problem than an archive/delete/revoke request 500ing because of it.
 */
import { eq, and, inArray } from "drizzle-orm";
import { ticketAlerts, withTenantContext } from "@platform/db";
import { logger } from "@platform/logger";
import { ticketAlertsQueue, ticketAlertJobId } from "./ticket-alerts-queue.js";

async function cancelPendingAlerts(
  tenantId: string,
  instanceId: string,
  createdBy: string | undefined,
): Promise<void> {
  try {
    const pendingIds = await withTenantContext(tenantId, async (tx) => {
      const rows = await tx
        .select({ id: ticketAlerts.id })
        .from(ticketAlerts)
        .where(
          and(
            eq(ticketAlerts.tenantId, tenantId),
            eq(ticketAlerts.instanceId, instanceId),
            eq(ticketAlerts.status, "pending"),
            ...(createdBy ? [eq(ticketAlerts.createdBy, createdBy)] : []),
          ),
        );
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return ids;

      await tx
        .update(ticketAlerts)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(inArray(ticketAlerts.id, ids));

      return ids;
    });

    await Promise.all(
      pendingIds.map((id) => ticketAlertsQueue.remove(ticketAlertJobId(id))),
    );

    if (pendingIds.length > 0) {
      logger.info(
        { tenantId, instanceId, createdBy, count: pendingIds.length },
        "Cascade-cancelled pending ticket alerts",
      );
    }
  } catch (err) {
    logger.error(
      { err, tenantId, instanceId, createdBy },
      "Failed to cascade-cancel ticket alerts",
    );
  }
}

/** Ticket archived/deleted — cancel every pending alert on it, any creator. */
export async function cancelAllPendingAlertsForInstance(
  tenantId: string,
  instanceId: string,
): Promise<void> {
  await cancelPendingAlerts(tenantId, instanceId, undefined);
}

/** A user's ticket access was revoked — cancel their own pending alerts on it. */
export async function cancelUsersPendingAlertsForInstance(
  tenantId: string,
  instanceId: string,
  userId: string,
): Promise<void> {
  await cancelPendingAlerts(tenantId, instanceId, userId);
}
