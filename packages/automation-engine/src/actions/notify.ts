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
import { validateWebhookUrl } from "../ssrf-guard.js";
import { env } from "@platform/config";
import { AutomationError } from "../types.js";

export type { NotifyConfig };

/**
 * Validates a notify action link URL.
 * Permitted:
 *  1. Relative path starting with "/" (but not "//")
 *  2. Absolute http/https URL matching env.APP_URL's host or subdomain,
 *     AND passing the SSRF guard check.
 */
export async function validateNotifyLink(
  link: string,
  extraBlockCidrs: string[] = [],
): Promise<void> {
  if (link.startsWith("/") && !link.startsWith("//")) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    throw new AutomationError("NOTIFY_LINK_INVALID", {
      link,
      reason: "invalid-url",
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AutomationError("NOTIFY_LINK_INVALID", {
      link,
      reason: "scheme-not-allowed",
      scheme: parsed.protocol,
    });
  }

  if (env.APP_URL) {
    try {
      const appUrlParsed = new URL(env.APP_URL);
      const linkHost = parsed.hostname.toLowerCase();
      const appHost = appUrlParsed.hostname.toLowerCase();
      const isAllowedDomain =
        linkHost === appHost || linkHost.endsWith("." + appHost);
      if (!isAllowedDomain) {
        throw new AutomationError("NOTIFY_LINK_INVALID", {
          link,
          reason: "origin-not-allowed",
        });
      }
    } catch {
      throw new AutomationError("NOTIFY_LINK_INVALID", {
        link,
        reason: "app-url-parse-failed",
      });
    }
  }

  try {
    await validateWebhookUrl(link, extraBlockCidrs);
  } catch (err) {
    throw new AutomationError("NOTIFY_LINK_INVALID", {
      link,
      reason: "ssrf-blocked",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

// Routes tenant-authored "notify" actions through the same in-app
// notification hub as the 6 fixed system triggers (docs/specs/
// in-app-notification-hub.md, T10) — same tables, same read/unread UX, same
// websocket push, same outbound handoff. Content differs deliberately: the 6
// system triggers use hardcoded templates; this action's title/body/link
// come from the rule's own config, since a tenant-authored automation rule
// is already admin-configured content, not a free-text injection surface.
//
// Idempotency: the notification ID is derived deterministically from
// (tenantId, ruleId, jobEventId, recipientId). jobEventId is the outbox
// event row ID, which is constant across all BullMQ retries of the same
// job (the queue uses it as the jobId). execId is only used as a fallback
// for direct callers (isolation tests, one-off engine calls) where no
// stable outbox-backed ID exists and retries don't occur (#228).
function deriveNotificationId(
  tenantId: string,
  ruleId: string,
  jobEventId: string,
  recipientId: string,
): string {
  const hash = createHash("sha256")
    .update([tenantId, ruleId, jobEventId, recipientId].join(":"))
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
  outboxEventId?: string,
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

  if (link) {
    await validateNotifyLink(link, env.SSRF_BLOCK_CIDRS);
  }

  const notificationId = deriveNotificationId(
    tenantId,
    ruleId,
    outboxEventId ?? execId,
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
