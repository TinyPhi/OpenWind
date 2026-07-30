/**
 * Cascade-cancel hooks for ticket_alerts (docs/specs/ticket-alerts.md §R8).
 * Best-effort, mirrors emit-access-event.ts's philosophy: never block or fail
 * the primary operation (archive/delete/revoke) if cancellation has trouble —
 * an alert firing a little late for an archived/inaccessible ticket is a far
 * smaller problem than an archive/delete/revoke request 500ing because of it.
 */
import { eq, and, isNull, inArray } from "drizzle-orm";
import { ticketAlerts, entityRelations, withTenantContext } from "@platform/db";
import { RELATION_PARENT_OF } from "@platform/entity-engine";
import { logger } from "@platform/logger";
import { ticketAlertsQueue, ticketAlertJobId } from "./ticket-alerts-queue.js";
import { voidPendingAlertOutboxRows } from "./alert-outbox.js";

/**
 * BFS over active parent_of relations — same query shape as
 * packages/entity-engine/src/archive.ts's private collectActiveDescendants,
 * duplicated here (read-only, pre-archive) rather than imported: that
 * function isn't exported, and by the time archiveEntity() returns, it has
 * already soft-deleted the relations themselves (deletedAt = archiveTs), so
 * querying isNull(deletedAt) AFTER the fact would find nothing. Called
 * BEFORE archiveEntity() in archive.ts, while the relations are still active,
 * so the descendant set here matches exactly what archiveEntity is about to
 * cascade-archive.
 */
export async function collectActiveDescendantIds(
  tenantId: string,
  instanceId: string,
): Promise<string[]> {
  return withTenantContext(tenantId, async (tx) => {
    const result: string[] = [];
    const queue = [instanceId];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const children = await tx
        .select({ toInstanceId: entityRelations.toInstanceId })
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.tenantId, tenantId),
            eq(entityRelations.fromInstanceId, current),
            eq(entityRelations.relationType, RELATION_PARENT_OF),
            isNull(entityRelations.deletedAt),
          ),
        );
      for (const c of children) {
        result.push(c.toInstanceId);
        queue.push(c.toInstanceId);
      }
    }
    return result;
  });
}

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

      await Promise.all(ids.map((id) => voidPendingAlertOutboxRows(tx, id)));

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
