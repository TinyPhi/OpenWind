import { Worker, type Job } from "bullmq";
import { eq, and, ne } from "drizzle-orm";
import {
  db,
  withTenantContext,
  notifications,
  notificationRecipients,
  outboxEvents,
} from "@platform/db";
import { getUserById } from "@platform/auth";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { connection } from "./queues.js";
import { getNotificationOutboundToken } from "./notification-outbound-auth.js";
import { validateActiveTenant } from "./tenant-guard.js";

interface OutboundJobData {
  notificationId: string;
  tenantId: string;
}

interface OutboundPayload {
  notificationId: string;
  tenantId: string;
  title: string;
  body: string;
  link: string | null;
  recipients: Array<{ userId: string; email: string | null }>;
  // Per-notification channel flags, decided by trigger type — hardcoded here
  // for now (only email is wired; sms/whatsapp are false until the external
  // service's contract is settled). docs/specs/in-app-notification-hub.md.
  channels: { email: boolean; sms: boolean; whatsapp: boolean };
}

/**
 * notifications.link is stored as an app-relative path (e.g.
 * "/records/ticket-1/abc"), matching what the admin-ui router expects. The
 * outbound service has no notion of our routing base, so it needs the full,
 * clickable URL — resolved against APP_URL (config-driven; same var already
 * used for CORS_ORIGIN) rather than hardcoding a host here.
 */
// notifications.link is always app-relative by construction (every writer in
// this codebase stores a path like "/records/...", never a full URL) — an
// already-absolute link would only reach here from a future writer breaking
// that convention. new URL(link, APP_URL) passes an absolute link through
// unchanged (its own origin wins over the base), which is the right fallback
// if that ever happens, but is not something this function actively guards.
function toAbsoluteLink(link: string | null): string | null {
  if (!link) return null;
  if (!env.APP_URL) {
    logger.warn(
      {},
      "Notification outbound: APP_URL not configured — sending link as a relative path",
    );
    return link;
  }
  return new URL(link, env.APP_URL).toString();
}

/**
 * The single, isolated seam to the externally-owned notification service
 * (contract unresolved as of this feature). Everything upstream — triggers,
 * the in-app notifier, the DB tables — is stable regardless of what this
 * function's internals turn out to need; only this function changes once the
 * real contract is known.
 */
async function dispatchOutbound(payload: OutboundPayload): Promise<void> {
  if (!env.NOTIFICATION_SERVICE_URL) {
    logger.info(
      { notificationId: payload.notificationId },
      "Notification outbound: no NOTIFICATION_SERVICE_URL configured — treating as a no-op",
    );
    return;
  }

  const token = await getNotificationOutboundToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else {
    // Dispatch anyway — a misconfigured/missing key shouldn't silently no-op
    // this call the way NOTIFICATION_SERVICE_URL being unset does. The
    // outbound service will reject an unauthenticated call, and that
    // rejection flows through the exact same retry/system.error path as any
    // other outbound failure — no special-casing needed here.
    logger.warn(
      { notificationId: payload.notificationId },
      "Notification outbound: dispatching without an auth token — NOTIFICATION_ZITADEL_KEY_JSON/NOTIFICATION_ZITADEL_AUDIENCE not configured",
    );
  }

  const res = await fetch(env.NOTIFICATION_SERVICE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    // Without a timeout, a hung external notification service hangs this
    // BullMQ job indefinitely instead of failing and retrying/DLQ-ing.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Outbound service responded ${res.status}`);
  }
}

export const notificationOutboundWorker = new Worker<OutboundJobData>(
  "notify-outbound",
  async (job) => {
    const { notificationId, tenantId } = job.data;

    const active = await validateActiveTenant(tenantId, "Outbound dispatch", {
      notificationId,
      jobId: job.id,
    });
    if (!active) return;

    // notifications/notification_recipients both have RLS — this worker's DB
    // connection runs as app_user (no BYPASSRLS), so every query here must go
    // through withTenantContext or rows are simply invisible / writes fail.
    const claimed = await withTenantContext(tenantId, (tx) =>
      // De-dupe (R16): only a terminal "sent" blocks re-processing — the
      // external service must never be called again once a notification has
      // actually been delivered. "attempted" is deliberately NOT a blocking
      // state: it just marks that a delivery attempt is/was in flight, and a
      // BullMQ retry of the very same job (after a failed dispatchOutbound
      // call) must still be allowed to re-claim and actually retry the call.
      // Blocking on "attempted" here previously made every retry silently
      // no-op (return success without calling dispatchOutbound again), which
      // meant a permanently-down outbound service could never accumulate 3
      // real attempts and thus never emitted the system.error it should.
      tx
        .update(notifications)
        .set({ outboundStatus: "attempted" })
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.tenantId, tenantId),
            ne(notifications.outboundStatus, "sent"),
          ),
        )
        .returning(),
    );

    if (claimed.length === 0) {
      logger.info(
        { notificationId },
        "Notification outbound: already sent — skipping",
      );
      return;
    }

    const notification = claimed[0];
    if (!notification) return;

    const recipientRows = await withTenantContext(tenantId, (tx) =>
      tx
        .select({ userId: notificationRecipients.userId })
        .from(notificationRecipients)
        .where(
          and(
            eq(notificationRecipients.notificationId, notificationId),
            eq(notificationRecipients.tenantId, tenantId),
          ),
        ),
    );

    const recipients = await Promise.all(
      recipientRows.map(async (r) => {
        const user = await getUserById(r.userId);
        return { userId: r.userId, email: user?.email ?? null };
      }),
    );

    await dispatchOutbound({
      notificationId,
      tenantId,
      title: notification.title,
      body: notification.body,
      link: toAbsoluteLink(notification.link),
      recipients,
      channels: { email: true, sms: false, whatsapp: false },
    });

    await withTenantContext(tenantId, (tx) =>
      tx
        .update(notifications)
        .set({ outboundStatus: "sent" })
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.tenantId, tenantId),
          ),
        ),
    );
  },
  { connection },
);

async function handleFailedJob(
  job: Job<OutboundJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (!exhausted) return;

  const { notificationId, tenantId } = job.data;

  try {
    const [failedNotification] = await withTenantContext(tenantId, (tx) =>
      tx
        .update(notifications)
        .set({ outboundStatus: "failed" })
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.tenantId, tenantId),
          ),
        )
        .returning({ type: notifications.type }),
    );

    // A system.error notification's own outbound handoff can fail too (the
    // external service being down affects every notification alike) — never
    // re-emit system.error for that, or a downed outbound service cascades
    // into an unbounded system.error -> outbound-fails -> system.error loop.
    if (failedNotification?.type === "system.error") {
      logger.warn(
        { notificationId },
        "Notification outbound: system.error's own outbound handoff failed — not re-reporting to avoid a feedback loop",
      );
      return;
    }

    // R14: a permanently failed handoff is never silently dropped — it
    // surfaces as a system.error event, which flows through the exact same
    // notification hub (recipients = tenant admins) rather than a separate
    // failure-reporting path. outbox_events has RLS disabled by design
    // (0006_remove_internal_table_rls.sql) — it's written/read cross-tenant
    // by pollers, so no tenant context is needed for this insert.
    await db.insert(outboxEvents).values({
      tenantId,
      eventType: "system.error",
      version: 1,
      payload: {
        eventType: "system.error",
        version: 1,
        tenantId,
        context: { notificationId },
        reason: `Outbound handoff failed after ${job.attemptsMade} attempts: ${err.message}`,
      },
    });
  } catch (dlqErr) {
    logger.error(
      { notificationId, dlqErr },
      "Notification outbound: failed to record permanent failure",
    );
  }
}

notificationOutboundWorker.on("failed", (job, err) => {
  void handleFailedJob(job, err);
});

export function stopNotificationOutboundWorker(): Promise<void> {
  return notificationOutboundWorker.close();
}
