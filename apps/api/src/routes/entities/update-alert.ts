import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "@platform/auth";
import {
  entityInstances,
  ticketAlerts,
  outboxEvents,
  withTenantContext,
} from "@platform/db";
import { factory } from "./factory.js";
import { explicitAccessListUserIds } from "../../lib/entity-access.js";
import { voidPendingAlertOutboxRows } from "../../lib/alert-outbox.js";
import {
  ticketAlertsQueue,
  ticketAlertJobId,
} from "../../lib/ticket-alerts-queue.js";

const UpdateAlertSchema = z.object({
  note: z.string().min(1).max(2000).optional(),
  fireAt: z.string().datetime().optional(),
  scope: z.enum(["me", "all"]).optional(),
});

export const updateAlertHandler = factory.createHandlers(
  requireAuth(),
  zValidator("json", UpdateAlertSchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const alertId = c.req.param("alertId") ?? "";
    const { tenantId, userId } = c.get("auth");
    const patch = c.req.valid("json");

    if (patch.fireAt && new Date(patch.fireAt).getTime() <= Date.now()) {
      return c.json(
        { error: "FIRE_AT_IN_PAST", message: "fireAt must be in the future" },
        422,
      );
    }

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
        // scope='all' alerts are visible to others (§R2) so existence isn't
        // secret — 403. scope='me' alerts are invisible to others — 404
        // avoids leaking that this alert exists at all. See §R3.
        return existing.scope === "all"
          ? { status: 403 as const }
          : { status: 404 as const };
      }
      if (existing.status !== "pending") {
        return { status: 409 as const };
      }

      const nextScope = patch.scope ?? existing.scope;
      const nextFireAt = patch.fireAt
        ? new Date(patch.fireAt)
        : existing.fireAt;

      let recipientsSnapshot = existing.recipientsSnapshot;
      if (nextScope === "all" && existing.scope !== "all") {
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
        recipientsSnapshot = instance
          ? explicitAccessListUserIds(instance, userId)
          : null;
      } else if (nextScope === "me") {
        recipientsSnapshot = null;
      }

      const [updated] = await tx
        .update(ticketAlerts)
        .set({
          note: patch.note ?? existing.note,
          fireAt: nextFireAt,
          scope: nextScope,
          recipientsSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(ticketAlerts.id, alertId))
        .returning();

      // Void any not-yet-polled outbox row from creation (or a prior rapid
      // edit) before inserting the fresh one — otherwise the scheduler could
      // poll the stale row first and silently keep the OLD schedule (BullMQ
      // ignores a second add() with the same jobId). See alert-outbox.ts.
      await voidPendingAlertOutboxRows(tx, alertId);
      await tx.insert(outboxEvents).values({
        tenantId,
        eventType: "ticket.alert_scheduled",
        version: 1,
        payload: { alertId, fireAt: nextFireAt.toISOString() },
      });

      return { status: 200 as const, alert: updated };
    });

    if (result.status === 404) {
      return c.json({ error: "NOT_FOUND", message: "Alert not found" }, 404);
    }
    if (result.status === 403) {
      return c.json(
        { error: "FORBIDDEN", message: "Only the creator can edit this alert" },
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

    // Cancel any already-enqueued job only now that ownership+status passed
    // — a no-op if the poller hasn't picked it up yet. Doing this before the
    // authorization check would let anyone who merely knows/guesses an
    // alertId cancel its scheduled job via Redis, without passing any of the
    // above tenant/ownership checks. The fire-time worker's status='pending'
    // guard (§R5) makes this best-effort, not load-bearing, but removing it
    // keeps a stray job from sitting in Redis until it fires.
    await ticketAlertsQueue.remove(ticketAlertJobId(alertId));

    return c.json({ data: result.alert });
  },
);
