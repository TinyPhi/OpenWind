import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and, count } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import {
  entityInstances,
  ticketAlerts,
  outboxEvents,
  withTenantContext,
} from "@platform/db";
import { factory } from "./factory.js";
import {
  hasEntityReadAccess,
  explicitAccessListUserIds,
} from "../../lib/entity-access.js";

const MAX_PENDING_ALERTS_PER_USER_PER_TICKET = 20;

const CreateAlertSchema = z.object({
  note: z.string().min(1).max(2000),
  fireAt: z.string().datetime(),
  scope: z.enum(["me", "all"]),
});

export const createAlertHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateAlertSchema),
  async (c) => {
    const instanceId = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const { note, fireAt, scope } = c.req.valid("json");

    const fireAtDate = new Date(fireAt);
    if (fireAtDate.getTime() <= Date.now()) {
      return c.json(
        { error: "FIRE_AT_IN_PAST", message: "fireAt must be in the future" },
        422,
      );
    }

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

      const pendingCountRows = await tx
        .select({ value: count() })
        .from(ticketAlerts)
        .where(
          and(
            eq(ticketAlerts.tenantId, tenantId),
            eq(ticketAlerts.instanceId, instanceId),
            eq(ticketAlerts.createdBy, userId),
            eq(ticketAlerts.status, "pending"),
          ),
        );
      const pendingCount = pendingCountRows[0]?.value ?? 0;

      if (pendingCount >= MAX_PENDING_ALERTS_PER_USER_PER_TICKET) {
        return { status: 422 as const, code: "ALERT_CAP_EXCEEDED" as const };
      }

      const recipientsSnapshot =
        scope === "all" ? explicitAccessListUserIds(instance, userId) : null;

      const inserted = await tx
        .insert(ticketAlerts)
        .values({
          tenantId,
          instanceId,
          createdBy: userId,
          note,
          fireAt: fireAtDate,
          scope,
          recipientsSnapshot,
        })
        .returning();
      const alert = inserted[0];
      if (!alert) throw new Error("ticket_alerts insert returned no row");

      await tx.insert(outboxEvents).values({
        tenantId,
        eventType: "ticket.alert_scheduled",
        version: 1,
        payload: { alertId: alert.id, fireAt: fireAtDate.toISOString() },
      });

      return { status: 201 as const, alert };
    });

    if (result.status === 404) {
      return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
    }
    if (result.status === 422) {
      return c.json(
        {
          error: result.code,
          message: "Maximum pending alerts reached for this ticket",
        },
        422,
      );
    }
    return c.json({ data: result.alert }, 201);
  },
);
