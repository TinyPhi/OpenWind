import { randomUUID } from "node:crypto";
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
// Known limitation: unlike the 6 system triggers, this notification's id is
// a fresh randomUUID(), not derived from a stable outbox-event id — so if
// the whole automation job this action runs inside is retried by BullMQ
// (e.g. a later action in the same rule throws), this notify action could
// fire twice. Accepted for now; revisit if automation retries turn out to
// hit this action in practice.
export async function executeNotifyAction(
  db: DbOrTx,
  tenantId: string,
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

  const notificationId = randomUUID();

  await db.insert(notifications).values({
    id: notificationId,
    tenantId,
    type: "automation.notify",
    title,
    body,
    link,
  });

  await db.insert(notificationRecipients).values({
    notificationId,
    tenantId,
    userId: recipientId,
  });

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
