import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { and, eq, isNull, or } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  entityInstances,
  notificationPolicies,
  notifications,
  notificationRecipients,
  isOutboundNotificationsEnabled,
} from "@platform/db";
import { getActiveScheduleForTeam } from "@platform/teams";
import { writeAuditEntry } from "@platform/audit";
import { Queue, notificationDispatchTotal } from "@platform/telemetry";
import { logger } from "@platform/logger";
import type { TriggerEvent } from "../event-schemas.js";
import type { DispatchSeverityNotificationConfig } from "../types.js";

export type { DispatchSeverityNotificationConfig };

type Channel = "email" | "sms" | "whatsapp" | "call";

interface ResolvedPolicy {
  policyId: string | null;
  channels: readonly string[];
  notifyBackup: boolean;
  notifyEscalationManager: boolean;
  matchedAt:
    | "team+workflow"
    | "team"
    | "workflow"
    | "global"
    | "hardcoded-default";
}

// docs/oncall-routing-design.md §3.2's specificity-scoring algorithm — the
// same scoring apps/api/src/routes/admin/notification-policies.ts's
// GET /resolve dry-run endpoint uses. Kept as a self-contained query here
// (rather than importing the route module) since apps/api -> packages/
// automation-engine would be a reverse dependency, violating this repo's
// dependency rule (CLAUDE.md's dependency graph).
async function resolvePolicy(
  tx: DbOrTx,
  tenantId: string,
  severity: string,
  teamId: string | undefined,
  workflowTypeId: string | undefined,
): Promise<ResolvedPolicy> {
  const teamCondition = teamId
    ? (or(
        isNull(notificationPolicies.teamId),
        eq(notificationPolicies.teamId, teamId),
      ) ?? isNull(notificationPolicies.teamId))
    : isNull(notificationPolicies.teamId);
  const workflowCondition = workflowTypeId
    ? (or(
        isNull(notificationPolicies.workflowTypeId),
        eq(notificationPolicies.workflowTypeId, workflowTypeId),
      ) ?? isNull(notificationPolicies.workflowTypeId))
    : isNull(notificationPolicies.workflowTypeId);

  const candidates = await tx
    .select()
    .from(notificationPolicies)
    .where(
      and(
        eq(notificationPolicies.tenantId, tenantId),
        eq(notificationPolicies.severity, severity),
        isNull(notificationPolicies.deletedAt),
        teamCondition,
        workflowCondition,
      ),
    );

  const scored = candidates
    .map((p) => ({
      policy: p,
      score: (p.teamId ? 2 : 0) + (p.workflowTypeId ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];

  if (!best) {
    return {
      policyId: null,
      channels: ["email"],
      notifyBackup: true,
      notifyEscalationManager: false,
      matchedAt: "hardcoded-default",
    };
  }

  const matchedAt =
    best.policy.teamId && best.policy.workflowTypeId
      ? ("team+workflow" as const)
      : best.policy.teamId
        ? ("team" as const)
        : best.policy.workflowTypeId
          ? ("workflow" as const)
          : ("global" as const);

  return {
    policyId: best.policy.id,
    channels: best.policy.channels,
    notifyBackup: best.policy.notifyBackup,
    notifyEscalationManager: best.policy.notifyEscalationManager,
    matchedAt,
  };
}

function deriveNotificationId(
  tenantId: string,
  instanceId: string,
  severity: string,
  channel: string,
  recipientId: string,
): string {
  const hash = createHash("sha256")
    .update(
      [
        "dispatch_severity_notification",
        tenantId,
        instanceId,
        severity,
        channel,
        recipientId,
      ].join(":"),
    )
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

/**
 * docs/specs/oncall-routing.md R16-R20 — fires when a ticket's severity is
 * set or changed. Resolves the matching notification policy (R15's
 * specificity scoring), builds the recipient set from the on-call schedule
 * AT DISPATCH TIME (R17 — not the schedule as of ticket creation), and
 * writes one in-app `notifications` row per (channel, recipient) pair —
 * same direct-table-insert + outbound-queue-handoff pattern as
 * actions/notify.ts and resolve-oncall.ts's backup notification (this
 * package cannot depend on @platform/notifications' Novu wrapper — see
 * CLAUDE.md's dependency graph, automation-engine -> db/workflow-engine/
 * entity-engine/teams/audit only).
 *
 * R18's per-channel isolation is real at the layer this codebase actually
 * operates on today: each channel gets its own notification row and its own
 * insert/enqueue attempt, so one channel's failure never blocks another's,
 * and never touches the ticket row this event came from. Actual per-channel
 * PROVIDER delivery (Twilio SMS, WhatsApp, voice call) is a separate,
 * not-yet-built concern — apps/worker/src/notification-outbound-worker.ts's
 * own header comment notes sms/whatsapp are still hardcoded false pending
 * that external contract; `channel` on the notifications row (migration
 * 0105) is what lets that worker branch per-channel once it exists.
 */
export async function executeDispatchSeverityNotificationAction(
  db: DbOrTx,
  tenantId: string,
  event: TriggerEvent,
  config: DispatchSeverityNotificationConfig,
  redis?: Redis,
): Promise<void> {
  const instanceId =
    config.instanceId ?? ("instanceId" in event ? event.instanceId : undefined);
  if (!instanceId) return;

  let severity: string | undefined;

  if (event.eventType === "entity.updated") {
    const severityChange = event.changed["severity"];
    if (
      !severityChange ||
      typeof severityChange.new !== "string" ||
      !severityChange.new
    ) {
      return; // severity didn't change in this event
    }
    severity = severityChange.new;
  } else if (event.eventType === "entity.created") {
    const created = event.fields["severity"];
    if (typeof created !== "string" || !created) return;
    severity = created;
  } else {
    return;
  }

  const [instance] = await db
    .select({
      assignedTo: entityInstances.assignedTo,
      workflowId: entityInstances.workflowId,
      fields: entityInstances.fields,
    })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
        isNull(entityInstances.deletedAt),
      ),
    )
    .limit(1);
  if (!instance) return;

  const fields = instance.fields as Record<string, unknown>;
  const teamId =
    typeof fields["team_id"] === "string"
      ? (fields["team_id"] as string)
      : undefined;
  const workflowTypeId = instance.workflowId ?? undefined;

  const policy = await resolvePolicy(
    db,
    tenantId,
    severity,
    teamId,
    workflowTypeId,
  );

  // R17 — assignee is always in the recipient list regardless of policy;
  // backup/escalation manager are resolved from the CURRENT active schedule,
  // not whatever schedule was active when the ticket was created.
  const recipientIds = new Set<string>();
  if (instance.assignedTo) recipientIds.add(instance.assignedTo);

  if (teamId) {
    const schedule = await getActiveScheduleForTeam(
      db,
      tenantId,
      teamId,
      new Date(),
    );
    if (schedule) {
      if (policy.notifyBackup && schedule.backupUserId) {
        recipientIds.add(schedule.backupUserId);
      }
      if (
        (policy.notifyEscalationManager || severity === "critical") &&
        schedule.escalationManagerUserId
      ) {
        recipientIds.add(schedule.escalationManagerUserId);
      }
    }
  }

  const recipients = [...recipientIds];
  if (recipients.length === 0) {
    logger.info(
      { tenantId, instanceId, severity },
      "Automation: dispatch_severity_notification has no recipients — nothing to send",
    );
    return;
  }

  // R16/design §3.2 idempotency — claimed as late as possible, right before
  // the first actual side effect (the dispatch loop below), rather than up
  // front. Everything above this point is a read with no side effect, so
  // claiming earlier would risk permanently swallowing a legitimate retry if
  // the instance lookup transiently found nothing (replication lag) or
  // resolved zero recipients on a since-corrected state — the retry would
  // never get a fresh look at that same (instanceId, severity) key. A
  // SUBSEQUENT severity change still produces a new key and legitimately
  // re-dispatches, same as before.
  const idempotencyKey = `severity_notify:${instanceId}:${severity}`;
  if (redis) {
    const claimed = await redis.set(idempotencyKey, "1", "EX", 86400, "NX");
    if (claimed !== "OK") {
      logger.info(
        { tenantId, instanceId, severity },
        "Automation: dispatch_severity_notification skipped — already processed for this (ticket, severity) pair",
      );
      return;
    }
  } else {
    logger.warn(
      { tenantId, instanceId },
      "Automation: dispatch_severity_notification running without redis — idempotency guard disabled",
    );
  }

  const outboundEnabled = redis
    ? await isOutboundNotificationsEnabled()
    : false;
  const outboundQueue =
    redis && outboundEnabled
      ? new Queue("notify-outbound", { connection: redis })
      : null;

  // PR #600 review (Vijit, M1) -- per-channel outcome, so the
  // notification.dispatched audit entry below can distinguish a fully
  // successful dispatch from one where every channel failed, instead of
  // writing the same "dispatched" entry either way.
  const channelResults: Record<string, "ok" | "failed"> = {};

  try {
    // Channel dispatch is independent per channel (R18) — one channel's
    // insert/enqueue failure never suppresses the others, and this action
    // never touches the ticket row itself, so a notification failure can
    // never roll back the mutation that triggered it. Recipients within a
    // channel are likewise independent of each other: one recipient's
    // insert failing doesn't skip the rest of that channel's recipients.
    for (const channel of policy.channels as readonly Channel[]) {
      let channelFailure: string | undefined;

      for (const recipientId of recipients) {
        try {
          const notificationId = deriveNotificationId(
            tenantId,
            instanceId,
            severity,
            channel,
            recipientId,
          );

          await db
            .insert(notifications)
            .values({
              id: notificationId,
              tenantId,
              type: "ticket.severity_notification",
              channel,
              title: `Ticket severity: ${severity}`,
              body: `A ticket was set to ${severity} severity and requires attention.`,
              link: `/tickets/${instanceId}`,
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

          if (outboundQueue) {
            await outboundQueue
              .add(
                "dispatch",
                { notificationId, tenantId },
                { jobId: notificationId },
              )
              .catch((err: unknown) => {
                logger.error(
                  { err, tenantId, notificationId, channel },
                  "Automation: failed to enqueue severity notification outbound handoff",
                );
              });
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          channelFailure ??= message.slice(0, 200);
          logger.warn(
            { tenantId, instanceId, channel, recipientId },
            "Automation: dispatch_severity_notification recipient insert failed",
          );
          // continue — do not abort remaining recipients on this channel
        }
      }

      if (channelFailure) {
        channelResults[channel] = "failed";
        await writeAuditEntry(db, {
          tenantId,
          actorId: "system",
          actorType: "system",
          resourceType: "ticket",
          resourceId: instanceId,
          action: "notification.channel_failed",
          metadata: { channel, errorSummary: channelFailure },
        });
        notificationDispatchTotal.add(1, {
          channel,
          outcome: "channel_failed",
        });
      } else {
        channelResults[channel] = "ok";
        notificationDispatchTotal.add(1, { channel, outcome: "ok" });
      }
    }
  } finally {
    await outboundQueue?.close();
  }

  // PR #600 review (Vijit, M1) -- record channel outcomes so an operator
  // reading notification.dispatched entries can tell a fully successful
  // dispatch apart from a partial or total failure (previously written
  // unconditionally with no distinguishing signal).
  const results = Object.values(channelResults);
  const allChannelsFailed =
    results.length > 0 && results.every((r) => r === "failed");
  const partialFailure =
    results.some((r) => r === "failed") && !allChannelsFailed;
  await writeAuditEntry(db, {
    tenantId,
    actorId: "system",
    actorType: "system",
    resourceType: "ticket",
    resourceId: instanceId,
    action: "notification.dispatched",
    metadata: {
      severity,
      policyId: policy.policyId,
      matchedAt: policy.matchedAt,
      channels: policy.channels,
      recipientCount: recipients.length,
      channelResults,
      partialFailure,
      allChannelsFailed,
    },
  });

  logger.info(
    { tenantId, instanceId, severity, recipientCount: recipients.length },
    "Automation: dispatch_severity_notification dispatched",
  );
}
