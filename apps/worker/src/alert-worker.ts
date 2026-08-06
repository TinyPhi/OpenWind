/**
 * Alert Worker — BullMQ worker that fires when a delayed ticket-alert job
 * becomes due (docs/specs/ticket-alerts.md §R5, §R7).
 *
 * Idempotency guard (§R5): the status='pending' SELECT and the notification
 * INSERT + status flip to 'fired' are wrapped in a single transaction, same
 * TOCTOU-safe pattern as sla-breacher.ts. A BullMQ retry (attempts:3) on an
 * already-fired/cancelled alert re-checks the guard and no-ops.
 *
 * Delivery reuses the existing live pipeline unmodified (§R7): one
 * `notifications` row + one `notification_recipients` row per recipient,
 * the same Redis pub/sub live-push (NOTIFICATION_PUSH_CHANNEL) the websocket
 * layer (apps/api) forwards to connected clients — see notification-worker.ts,
 * whose shape this mirrors exactly — then the same `notify-outbound` handoff
 * every other in-app notification uses. No new delivery mechanism. Recipients
 * come from the alert's own columns (createdBy for scope='me',
 * recipientsSnapshot for scope='all'), never re-derived from live ticket
 * access.
 *
 * Notification body is the alert's own free-text note verbatim — an
 * intentional, scoped exception to notification-templates.ts's "never
 * interpolate free-text user content" rule; see the inline comment at the
 * title/body assignment below for the accepted-risk rationale.
 */

import { Worker } from "bullmq";
import { eq, and } from "drizzle-orm";
import {
  withTenantContext,
  ticketAlerts,
  notifications,
  notificationRecipients,
  isOutboundNotificationsEnabled,
} from "@platform/db";
import { logger } from "@platform/logger";
import { getRedis, NOTIFICATION_PUSH_CHANNEL } from "@platform/redis";
import { connection, notifyOutboundQueue } from "./queues.js";
import { buildRecordLink } from "./notification-templates.js";
import type { AlertJobData } from "./alert-scheduler.js";
import { validateActiveTenant } from "./tenant-guard.js";

export const alertWorker = new Worker<AlertJobData>(
  "ticket-alerts",
  async (job) => {
    const { alertId, tenantId } = job.data;

    const active = await validateActiveTenant(tenantId, "Alert fire", {
      alertId,
      jobId: job.id,
    });
    if (!active) return;

    // ticket_alerts/notifications/notification_recipients are all RLS-tenant
    // -scoped — withTenantContext sets both SET LOCAL ROLE app_user and the
    // app.tenant_id GUC the RLS policies check. A plain db.transaction() here
    // (as this file originally had) leaves that GUC unset, and the RLS
    // policy's `current_setting('app.tenant_id', true)::uuid` cast throws
    // "invalid input syntax for type uuid: ''" instead of just seeing 0 rows.
    const fired = await withTenantContext(tenantId, async (tx) => {
      const [alert] = await tx
        .select()
        .from(ticketAlerts)
        .where(
          and(
            eq(ticketAlerts.id, alertId),
            eq(ticketAlerts.tenantId, tenantId),
          ),
        )
        .limit(1);

      if (!alert) {
        logger.info(
          { tenantId, alertId },
          "Alert fire: alert not found — skipping",
        );
        return null;
      }
      if (alert.status !== "pending") {
        logger.info(
          { tenantId, alertId, status: alert.status },
          "Alert fire: alert already fired/cancelled — skipping (idempotent no-op)",
        );
        return null;
      }

      const recipients =
        alert.scope === "all"
          ? (alert.recipientsSnapshot ?? [alert.createdBy])
          : [alert.createdBy];
      const uniqueRecipients = Array.from(new Set(recipients));
      // Captured once so the DB row and the live-push payload below agree —
      // mirrors notification-worker.ts's identical reasoning (avoids a
      // second SELECT after insert just to read defaultNow() back).
      const createdAt = new Date();

      // Alerts are an intentional, scoped exception to notification-templates.ts's
      // "never interpolate free-text user content" rule: the note is written by
      // the alert's own creator for themselves or their chosen audience (not
      // arbitrary third-party content like a comment body), and the feature is
      // useless if the recipient can't tell what the alert is about without
      // opening the ticket. Accepted risk: a scope='all' recipient whose ticket
      // access is revoked after being snapshotted but before a still-pending
      // alert fires would still see the note via email, which has no
      // independent read-access check.
      const title = "Ticket alert";
      const body = alert.note;

      const insertedNotifications = await tx
        .insert(notifications)
        .values({
          tenantId,
          type: "ticket.alert",
          title,
          body,
          link: null, // filled in below once resolved — see instanceLink
          createdAt,
        })
        .returning({ id: notifications.id });
      const notification = insertedNotifications[0];
      if (!notification)
        throw new Error("notifications insert returned no row");

      await tx.insert(notificationRecipients).values(
        uniqueRecipients.map((userId) => ({
          notificationId: notification.id,
          tenantId,
          userId,
        })),
      );

      await tx
        .update(ticketAlerts)
        .set({ status: "fired", firedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(ticketAlerts.id, alertId),
            eq(ticketAlerts.tenantId, tenantId),
          ),
        );

      return {
        notificationId: notification.id,
        instanceId: alert.instanceId,
        recipients: uniqueRecipients,
        createdAt,
        title,
        body,
      };
    });

    if (!fired) return;

    // Best-effort: fill in the ticket link after the transaction (read-only,
    // failure here doesn't affect the already-committed notification).
    const link = await buildRecordLink(tenantId, fired.instanceId).catch(
      () => null,
    );
    if (link) {
      await withTenantContext(tenantId, (tx) =>
        tx
          .update(notifications)
          .set({ link })
          .where(
            and(
              eq(notifications.id, fired.notificationId),
              eq(notifications.tenantId, tenantId),
            ),
          ),
      ).catch((err: unknown) => {
        logger.error(
          { err, notificationId: fired.notificationId },
          "Alert fire: failed to attach ticket link",
        );
      });
    }

    // Live push — best-effort, not a delivery guarantee, identical shape to
    // notification-worker.ts's push so the same websocket layer (apps/api)
    // forwards it without any alert-specific handling. Without this, the
    // recipient only sees the alert on their next full page load/REST
    // refetch instead of live in the notification bell.
    const redis = getRedis();
    await Promise.all(
      fired.recipients.map((userId) =>
        redis
          .publish(
            NOTIFICATION_PUSH_CHANNEL,
            JSON.stringify({
              tenantId,
              userId,
              notification: {
                id: fired.notificationId,
                type: "ticket.alert",
                title: fired.title,
                body: fired.body,
                link,
                createdAt: fired.createdAt.toISOString(),
              },
            }),
          )
          .catch((err: unknown) => {
            logger.warn(
              { err, tenantId, userId, notificationId: fired.notificationId },
              "Alert fire: failed to publish live push",
            );
          }),
      ),
    );

    if (await isOutboundNotificationsEnabled()) {
      await notifyOutboundQueue
        .add(
          "dispatch",
          { notificationId: fired.notificationId, tenantId },
          { jobId: fired.notificationId },
        )
        .catch((err: unknown) => {
          logger.error(
            { err, tenantId, notificationId: fired.notificationId },
            "Alert fire: failed to enqueue outbound handoff",
          );
        });
    }

    logger.info(
      { tenantId, alertId, notificationId: fired.notificationId },
      "Alert fire: delivered",
    );
  },
  { connection },
);

alertWorker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, data: job?.data, err },
    "Alert fire job failed",
  );
});
