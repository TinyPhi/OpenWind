import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { Queue } from "bullmq";
import type { DbOrTx } from "@platform/db";
import {
  notifications,
  notificationRecipients,
  isOutboundNotificationsEnabled,
} from "@platform/db";
import { logger } from "@platform/logger";
import type { TriggerEvent } from "../event-schemas.js";
import type { NotifyConfig } from "../types.js";

export type { NotifyConfig };

// Routes tenant-authored "notify" actions through the same in-app
// notification hub as the 6 fixed system triggers (docs/specs/
// in-app-notification-hub.md, T10) — same tables, same read/unread UX, same
// websocket push, same outbound handoff. Content differs deliberately: the 6
// system triggers use hardcoded templates; this action's title/body/link
// come from the rule's own config, since a tenant-authored automation rule
// is already admin-configured content, not a free-text injection surface.
//
// Idempotency: the notification ID is derived deterministically from
// (tenantId, ruleId, execId, recipientId) so BullMQ retries of the same
// automation execution reuse the same ID and are deduplicated by the
// onConflictDoNothing insert (#228).
function deriveNotificationId(
  tenantId: string,
  ruleId: string,
  execId: string,
  recipientId: string,
): string {
  const hash = createHash("sha256")
    .update([tenantId, ruleId, execId, recipientId].join(":"))
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "4" + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) +
      hash.slice(18, 20),
    hash.slice(20, 32),
  ].join("-");
}

export async function executeNotifyAction(
  db: DbOrTx,
  tenantId: string,
  ruleId: string,
  execId: string,
  _event: TriggerEvent,
  config: NotifyConfig,
  redis?: Redis,
): Promise<void> {
  const recipientId = config.recipientId;
  if (!recipientId) {
    logger.warn(
      { tenantId },
      "Automation: notify action has no recipientId configured — skipping",
    );
    return;
  }

  const payload = config.payload ?? {};
  const title =
    typeof payload["title"] === "string" ? payload["title"] : "Notification";
  const body =
    typeof payload["body"] === "string"
      ? payload["body"]
      : "You have a new notification";
  const link = typeof payload["link"] === "string" ? payload["link"] : null;

  const notificationId = deriveNotificationId(
    tenantId,
    ruleId,
    execId,
    recipientId,
  );

  await db
    .insert(notifications)
    .values({
      id: notificationId,
      tenantId,
      type: "automation.notify",
      title,
      body,
      link,
    })
    .onConflictDoNothing();

  await db
    .insert(notificationRecipients)
    .values({
      notificationId,
      tenantId,
      userId: recipientId,
    })
    .onConflictDoNothing();

  if (redis) {
    if (await isOutboundNotificationsEnabled()) {
      // Same outbound queue apps/worker's notificationOutboundWorker already
      // consumes — jobId dedupes at the queue level if this exact call somehow
      // ran twice with the same notificationId.
      const queue = new Queue("notify-outbound", { connection: redis });
      await queue
        .add(
          "dispatch",
          { notificationId, tenantId },
          { jobId: notificationId },
        )
        .catch((err: unknown) => {
          logger.error(
            { err, tenantId, notificationId },
            "Automation: failed to enqueue outbound handoff for notify action",
          );
        });
    } else {
      logger.info(
        { tenantId, notificationId },
        "Automation: outbound handoff skipped — global kill switch is disabled",
      );
    }
  }

  logger.info(
    { tenantId, recipientId, notificationId },
    "Automation: notify action delivered in-app",
  );
}
