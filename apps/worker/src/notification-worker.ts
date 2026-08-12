import { Worker, type Job } from "bullmq";
import { eq, and } from "drizzle-orm";
import {
  withTenantContext,
  notifications,
  notificationRecipients,
  tenantUsers,
  deadLetterEvents,
  isOutboundNotificationsEnabled,
  workflowEvents,
  accessRequests,
} from "@platform/db";
import { getRedis, NOTIFICATION_PUSH_CHANNEL } from "@platform/redis";
import { logger } from "@platform/logger";
import { connection, notifyOutboundQueue } from "./queues.js";
import { resolveRecipients } from "./notification-recipients.js";
import { buildNotificationContent } from "./notification-templates.js";
import { validateActiveTenant } from "./tenant-guard.js";

// The 3 ticket-room-only event types from docs/specs/ticket-live-updates.md —
// each publishes a room-scoped live push independent of whatever (if any)
// per-user inbox notification the same outbox event also produces (spec §V:
// "a room-scoped outbox event's existence never implies a
// notifications/notification_recipients row was written, and vice versa").
const ROOM_EVENT_TYPES = new Set([
  "comment.created",
  "access_request.created",
  "access_request.updated",
]);

interface RoomPushPayload {
  instanceId?: string;
  actorId?: string;
  commentId?: string;
  requestId?: string;
  status?: string;
}

async function publishRoomUpdate(
  tenantId: string,
  eventType: string,
  payload: RoomPushPayload,
): Promise<void> {
  const instanceId = payload.instanceId;
  if (!instanceId) return;

  let message: Record<string, unknown> | null = null;

  if (eventType === "comment.created" && payload.commentId) {
    const commentId = payload.commentId;
    const [comment] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          metadata: workflowEvents.metadata,
          actorId: workflowEvents.actorId,
          createdAt: workflowEvents.createdAt,
        })
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.id, commentId),
            eq(workflowEvents.tenantId, tenantId),
          ),
        )
        .limit(1),
    );
    if (!comment) return;
    const metadata = comment.metadata as { text?: string } | null;
    message = {
      type: "comment.created",
      instanceId,
      comment: {
        id: commentId,
        body: metadata?.text ?? "",
        authorId: comment.actorId,
        createdAt: comment.createdAt.toISOString(),
      },
    };
  } else if (
    (eventType === "access_request.created" ||
      eventType === "access_request.updated") &&
    payload.requestId
  ) {
    const requestId = payload.requestId;
    const [request] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          requesterId: accessRequests.requesterId,
          status: accessRequests.status,
          resolvedBy: accessRequests.resolvedBy,
          resolvedAt: accessRequests.resolvedAt,
          createdAt: accessRequests.createdAt,
        })
        .from(accessRequests)
        .where(
          and(
            eq(accessRequests.id, requestId),
            eq(accessRequests.tenantId, tenantId),
          ),
        )
        .limit(1),
    );
    if (!request) return;
    message = {
      type: eventType,
      instanceId,
      request: {
        id: requestId,
        requestedBy: request.requesterId,
        status: request.status,
        ...(request.resolvedBy && { resolvedBy: request.resolvedBy }),
        ...(request.resolvedAt && {
          resolvedAt: request.resolvedAt.toISOString(),
        }),
        createdAt: request.createdAt.toISOString(),
      },
    };
  }

  if (!message) return;

  const redis = getRedis();
  await redis
    .publish(
      NOTIFICATION_PUSH_CHANNEL,
      JSON.stringify({ kind: "room", tenantId, instanceId, message }),
    )
    .catch((err: unknown) => {
      logger.warn(
        { err, tenantId, instanceId, eventType },
        "Notification: failed to publish ticket-room live push",
      );
    });
}

interface NotificationJobData {
  outboxEventId: string;
  tenantId: string;
  eventType: string;
  version: number;
  payload: Record<string, unknown>;
}

async function resolveActorName(
  tenantId: string,
  actorId: string | null,
): Promise<string> {
  if (!actorId) return "System";
  // tenant_users has RLS — this worker's DB connection runs as app_user (no
  // BYPASSRLS), so this MUST go through withTenantContext or Postgres treats
  // app.tenant_id as unset and the row is invisible, not merely slow.
  const [user] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({ displayName: tenantUsers.displayName })
      .from(tenantUsers)
      .where(
        and(
          eq(tenantUsers.tenantId, tenantId),
          eq(tenantUsers.userId, actorId),
        ),
      )
      .limit(1),
  );
  // R17: a deleted/never-seen actor falls back to a placeholder rather than
  // failing the notification.
  return user?.displayName ?? "A user";
}

export const notificationWorker = new Worker<NotificationJobData>(
  "notify",
  async (job) => {
    const { tenantId, eventType, payload } = job.data;

    const active = await validateActiveTenant(
      tenantId,
      "Notification processing",
      {
        eventType,
        jobId: job.id,
      },
    );
    if (!active) return;

    // Room push fires independent of inbox-notification recipient resolution
    // below — e.g. a plain non-mention comment has zero notification
    // recipients but must still reach every current viewer of the ticket.
    if (ROOM_EVENT_TYPES.has(eventType)) {
      await publishRoomUpdate(tenantId, eventType, payload);
    }

    const resolved = await resolveRecipients(tenantId, eventType, payload);
    // Invariant: a notifications row is never created without at least one
    // recipient (e.g. every candidate was the actor themself).
    if (resolved.recipients.length === 0) return;

    const actorName = await resolveActorName(tenantId, resolved.actorId);
    const content = await buildNotificationContent(eventType, {
      tenantId,
      instanceId: resolved.instanceId,
      actorName,
      reason: resolved.reason,
    });

    // Idempotency (R1): the notification's id is deterministically derived
    // from the outbox event id, not a fresh random UUID — so a BullMQ retry
    // of this same job re-uses the same id and onConflictDoNothing makes the
    // retry a no-op instead of a duplicate. Random per-attempt UUIDs would
    // defeat the unique constraint entirely, since it dedupes per
    // (notification_id, user_id), not per outbox event.
    const notificationId = job.data.outboxEventId;
    // Set explicitly (rather than relying on the column's defaultNow())
    // so the exact same value is known here for the live-push payload below
    // — the alternative is a second SELECT after insert just to read it back.
    const createdAt = new Date();

    // notifications/notification_recipients both have RLS — same reasoning
    // as resolveActorName above.
    await withTenantContext(tenantId, async (tx) => {
      await tx
        .insert(notifications)
        .values({
          id: notificationId,
          tenantId,
          type: eventType,
          title: content.title,
          body: content.body,
          link: content.link,
          createdAt,
        })
        .onConflictDoNothing();

      await tx
        .insert(notificationRecipients)
        .values(
          resolved.recipients.map((userId) => ({
            notificationId,
            tenantId,
            userId,
          })),
        )
        .onConflictDoNothing();
    });

    // Live push — best-effort, not a delivery guarantee (R9). Keyed by
    // (tenantId, userId) together, never userId alone (see spec §V) — the
    // websocket layer (apps/api) validates the pair before forwarding to a
    // connection.
    const redis = getRedis();
    await Promise.all(
      resolved.recipients.map((userId) =>
        redis
          .publish(
            NOTIFICATION_PUSH_CHANNEL,
            JSON.stringify({
              tenantId,
              userId,
              notification: {
                id: notificationId,
                type: eventType,
                title: content.title,
                body: content.body,
                link: content.link,
                createdAt: createdAt.toISOString(),
              },
            }),
          )
          .catch((err: unknown) => {
            logger.warn(
              { err, tenantId, userId, notificationId },
              "Notification: failed to publish live push",
            );
          }),
      ),
    );

    // Outbound handoff — deterministic jobId (the notification id) makes the
    // enqueue itself idempotent across retries of this job, independent of
    // the de-dupe marker the outbound worker also checks (R16). Gated by the
    // global kill switch (docs/specs/outbound-notifications-kill-switch.md) —
    // in-app delivery above is unaffected either way.
    if (await isOutboundNotificationsEnabled()) {
      await notifyOutboundQueue.add(
        "dispatch",
        { notificationId, tenantId },
        { jobId: notificationId },
      );
    } else {
      logger.info(
        { tenantId, notificationId },
        "Notification: outbound handoff skipped — global kill switch is disabled",
      );
    }

    logger.info(
      {
        tenantId,
        notificationId,
        eventType,
        recipients: resolved.recipients.length,
      },
      "Notification: in-app delivery complete",
    );
  },
  { connection, concurrency: 5 },
);

// Without this, a thrown error (e.g. the RLS bug this comment replaced) fails
// silently — BullMQ retries 3 times then marks the job failed with no log
// line anywhere, exactly the gap that made this class of bug invisible until
// queried directly out of Redis. Matches automation-worker.ts's convention.
async function handleFailedJob(
  job: Job<NotificationJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;

  const { outboxEventId, tenantId, eventType, payload } = job.data;
  try {
    await withTenantContext(tenantId, (tx) =>
      tx.insert(deadLetterEvents).values({
        tenantId,
        originalEventId: outboxEventId,
        eventType,
        payload,
        ruleId: null,
        error: err.message,
        attemptCount: job.attemptsMade,
      }),
    );
    logger.warn(
      { tenantId, outboxEventId, eventType },
      "Notification: job moved to dead letter queue",
    );
  } catch (dlqErr) {
    logger.error(
      { tenantId, outboxEventId, dlqErr },
      "Notification: failed to write to dead letter queue",
    );
  }
}

notificationWorker.on("failed", (job, err) => {
  void handleFailedJob(job, err);
});

export function stopNotificationWorker(): Promise<void> {
  return notificationWorker.close();
}
