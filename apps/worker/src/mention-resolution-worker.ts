/**
 * mention-resolution-worker.ts
 *
 * BullMQ processor for the "mention-resolution" queue (ADR-012 Phase C, spec
 * R4/R5/R6/R7). Runs fully after a third-party comment's own API response has
 * already been sent — the comment insert never blocks on any of this (design
 * doc §4.4, mirrors the attachment AV-scan pattern).
 *
 * For each mentioned identifier, resolves exactly one of three outcomes:
 *   1. already has ticket access -> tagged, no access change
 *   2. has workflow access (any tenant member holding the "user" role,
 *      matching the pre-existing @mention picker's own definition — see
 *      apps/api/src/routes/platform/users.ts) but not this ticket ->
 *      workflow's allow_auto_grant_on_mention ON: auto-grant read-only;
 *      OFF (default): create an access-request instead
 *   3. identifier doesn't resolve, or resolves but isn't a "user"-role tenant
 *      member -> generic fallback, no access change
 *
 * Outcomes 3's two sub-cases are timing-equalized: every resolution performs
 * exactly one org-user lookup and one ticket-access check regardless of
 * whether the identifier matched anyone, so "unknown identifier" and "known,
 * no access" cost the same regardless of which one actually happened.
 *
 * Every outcome (plus a retry-exhausted failure) is logged via
 * writeAuditEntry into admin_audit_log — the interim sink until Phase F's
 * Access Logs screen exists (see the Phase C spec's §C "new schema" row).
 */

import { Worker } from "bullmq";
import { eq, and, sql, isNull } from "drizzle-orm";
import {
  entityInstances,
  workflows,
  accessRequests,
  outboxEvents,
  withTenantContext,
} from "@platform/db";
import {
  listOrgUsers,
  listUserRolesByUserId,
  type OrgUser,
} from "@platform/auth";
import { hasEntityAccess, emitAccessEvent } from "@platform/workflow-engine";
import { writeAuditEntry } from "@platform/audit";
import { fireMisuseAlert } from "@platform/notifications";
import { checkRateLimit, getRedis } from "@platform/redis";
import { logger } from "@platform/logger";
import { connection } from "./queues.js";
import { validateActiveTenant } from "./tenant-guard.js";

export type MentionResolutionJob = {
  tenantId: string;
  orgId: string;
  ticketId: string;
  workflowId: string;
  /** Email or Zitadel org user ID — never a display name (spec R4). */
  mentionIdentifier: string;
  /** The comment's own author, for audit attribution of the tag action. */
  actingPersonId: string;
  commentId: string;
};

// Per-ticket rolling-window cap on tagging-driven auto-grants (spec R7),
// separate from the general API rate limit. Config values, not hardcoded
// architecture — tests assert against these defaults.
const AUTO_GRANT_RATE_LIMIT = 5;
const AUTO_GRANT_RATE_WINDOW_SECONDS = 60 * 60;

type Outcome = 1 | 2 | 3;

async function resolveIdentifier(
  orgId: string,
  identifier: string,
): Promise<{ userId: string; isTenantUser: boolean } | null> {
  const [zitadelUsers, rolesByUserId] = await Promise.all([
    orgId ? listOrgUsers(orgId) : Promise.resolve<OrgUser[]>([]),
    orgId
      ? listUserRolesByUserId(orgId)
      : Promise.resolve(new Map<string, string[]>()),
  ]);

  const lowerIdentifier = identifier.toLowerCase();
  const match = zitadelUsers.find(
    (u: OrgUser) =>
      u.userId === identifier || u.email.toLowerCase() === lowerIdentifier,
  );
  if (!match) return null;

  const roles = rolesByUserId.get(match.userId) ?? [];
  // Matches apps/api/src/routes/platform/users.ts's own @mention-picker
  // filter exactly (ADR-012 Phase C's resolved definition of "has workflow
  // access" — there is no narrower per-workflow membership concept in this
  // codebase, confirmed before implementing this worker) — agents/admins are
  // never mentionable/auto-grantable via this path.
  return { userId: match.userId, isTenantUser: roles.includes("user") };
}

export const mentionResolutionWorker = new Worker<MentionResolutionJob>(
  "mention-resolution",
  async (job) => {
    const {
      tenantId,
      orgId,
      ticketId,
      workflowId,
      mentionIdentifier,
      actingPersonId,
      commentId,
    } = job.data;

    const active = await validateActiveTenant(tenantId, "mention-resolution", {
      jobId: job.id,
    });
    if (!active) return;

    const [instance] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: entityInstances.id,
          workflowId: entityInstances.workflowId,
          createdBy: entityInstances.createdBy,
          assignedTo: entityInstances.assignedTo,
          fields: entityInstances.fields,
        })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, ticketId),
            eq(entityInstances.tenantId, tenantId),
            isNull(entityInstances.deletedAt),
          ),
        )
        .limit(1),
    );
    if (!instance) {
      logger.warn(
        { tenantId, ticketId, jobId: job.id },
        "mention-resolution: ticket not found — skipping (deleted after comment?)",
      );
      return;
    }

    const resolved = await resolveIdentifier(orgId, mentionIdentifier);

    // Timing equalization (spec R5/R6): every job performs exactly one
    // hasEntityAccess-shaped DB call regardless of whether resolveIdentifier
    // found a match, using the ticket's own creator as a harmless dummy
    // target when it didn't — otherwise "unknown identifier" (which skips
    // this call) would be measurably faster than "known, no access" (which
    // doesn't), reopening the timing side-channel R6 exists to close.
    const accessCheckTargetId = resolved?.userId ?? instance.createdBy ?? "";
    const hasAccess = await withTenantContext(tenantId, (tx) =>
      hasEntityAccess(tx, tenantId, instance, accessCheckTargetId, []),
    );

    let outcome: Outcome;
    if (resolved?.isTenantUser && hasAccess) {
      outcome = 1;
    } else if (resolved?.isTenantUser) {
      outcome = 2;
    } else {
      outcome = 3;
    }

    if (outcome === 1) {
      await withTenantContext(tenantId, (tx) =>
        writeAuditEntry(tx, {
          tenantId,
          actorId: actingPersonId,
          actorType: "api_key",
          actingPersonId,
          resourceType: "ticket",
          resourceId: ticketId,
          action: "tag.resolved_existing_access",
          metadata: { commentId, mentionIdentifier },
        }),
      );
      return;
    }

    if (outcome === 3) {
      await withTenantContext(tenantId, (tx) =>
        writeAuditEntry(tx, {
          tenantId,
          actorId: actingPersonId,
          actorType: "api_key",
          actingPersonId,
          resourceType: "ticket",
          resourceId: ticketId,
          action: "tag.fallback",
          metadata: { commentId, mentionIdentifier },
        }),
      );
      return;
    }

    // Outcome 2 — resolved is guaranteed non-null here (outcome 2 is only
    // reached when resolved?.isTenantUser was true above).
    if (!resolved) {
      throw new Error(
        "unreachable: outcome 2 requires resolved.isTenantUser to be true",
      );
    }
    const grantedUserId = resolved.userId;

    const [workflowRow] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({ allowAutoGrantOnMention: workflows.allowAutoGrantOnMention })
        .from(workflows)
        .where(
          and(eq(workflows.id, workflowId), eq(workflows.tenantId, tenantId)),
        )
        .limit(1),
    );

    if (!workflowRow?.allowAutoGrantOnMention) {
      // Toggle OFF (default) — create an access-request via the same table/
      // insert shape as the existing human-UI flow
      // (apps/api/src/routes/entities/request-access.ts), so the existing
      // approval + creator/assignee-only notification machinery (already
      // built and tested) picks it up unchanged.
      await withTenantContext(tenantId, async (tx) => {
        // onConflictDoNothing against the existing one-pending-per-requester
        // partial unique index (migration 0028) — a mention that arrives
        // while an identical pending request already exists (e.g. the
        // person was already manually asking for access) doesn't create a
        // duplicate row; the existing pending request stands.
        const insertedRequest = await tx
          .insert(accessRequests)
          .values({
            tenantId,
            instanceId: ticketId,
            requesterId: grantedUserId,
            requestedLevel: "read_only",
          })
          .onConflictDoNothing()
          .returning({ id: accessRequests.id });

        // Only fire the notification-triggering outbox event on a genuine
        // new insert — onConflictDoNothing means an existing pending request
        // for this person already has its own notification in flight
        // (mirrors request-access.ts's own upsert-vs-insert distinction).
        if (insertedRequest[0]) {
          await tx.insert(outboxEvents).values({
            tenantId,
            eventType: "access_request.created",
            version: 1,
            payload: {
              eventType: "access_request.created",
              version: 1,
              tenantId,
              instanceId: ticketId,
              actorId: grantedUserId,
              requestId: insertedRequest[0].id,
            },
          });
        }

        await writeAuditEntry(tx, {
          tenantId,
          actorId: actingPersonId,
          actorType: "api_key",
          actingPersonId,
          resourceType: "ticket",
          resourceId: ticketId,
          action: "tag.access_request_created",
          metadata: { commentId, mentionIdentifier, grantedUserId },
        });
      });
      return;
    }

    // Toggle ON — auto-grant, subject to the per-ticket rolling-window cap.
    const rateLimitKey = `mention-auto-grant:${tenantId}:${ticketId}`;
    const rateLimit = await checkRateLimit(
      getRedis(),
      rateLimitKey,
      AUTO_GRANT_RATE_LIMIT,
      AUTO_GRANT_RATE_WINDOW_SECONDS,
    );

    if (!rateLimit.allowed) {
      // ADR-012 Phase F, spec R4 trigger 3 -- fires through the same
      // fireMisuseAlert channel as triggers 1/2 (apps/api/src/lib/
      // misuse-alerts.ts), not a separate mechanism. Naturally one-shot: this
      // branch itself already only runs once per cap-hit per
      // AUTO_GRANT_RATE_WINDOW_SECONDS (checkRateLimit's own window), so no
      // extra dedup bookkeeping is needed here.
      await withTenantContext(tenantId, async (tx) => {
        await writeAuditEntry(tx, {
          tenantId,
          actorId: actingPersonId,
          actorType: "api_key",
          actingPersonId,
          resourceType: "ticket",
          resourceId: ticketId,
          action: "tag.misuse_rate_capped",
          metadata: { commentId, mentionIdentifier, grantedUserId },
        });
        await fireMisuseAlert(
          tx,
          tenantId,
          `Ticket ${ticketId} hit its tagging-driven auto-grant rate cap (${AUTO_GRANT_RATE_LIMIT} per ${AUTO_GRANT_RATE_WINDOW_SECONDS}s)`,
          {
            source: "third-party-api-misuse",
            trigger: "tagging_grant_cap",
            ticketId,
            actingPersonId,
          },
        );
      });
      return;
    }

    const grantApplied = await withTenantContext(tenantId, async (tx) => {
      const updatedRows = await tx
        .update(entityInstances)
        .set({
          fields: sql`jsonb_set(
            jsonb_set(
              fields,
              '{__accessUsers}',
              CASE
                WHEN jsonb_typeof(COALESCE(fields->'__accessUsers', 'null'::jsonb)) = 'object'
                THEN fields->'__accessUsers'
                ELSE '{}'::jsonb
              END
            ),
            ARRAY['__accessUsers', ${grantedUserId}::text],
            jsonb_build_object('level', to_jsonb('read_only'::text), 'tag', to_jsonb('mention'::text))
          )`,
        })
        .where(
          and(
            eq(entityInstances.id, ticketId),
            eq(entityInstances.tenantId, tenantId),
            isNull(entityInstances.deletedAt),
          ),
        )
        .returning({ id: entityInstances.id });

      if (updatedRows.length > 0) {
        await writeAuditEntry(tx, {
          tenantId,
          actorId: actingPersonId,
          actorType: "api_key",
          actingPersonId,
          resourceType: "ticket",
          resourceId: ticketId,
          action: "tag.auto_granted",
          metadata: { commentId, mentionIdentifier, grantedUserId },
        });
        return true;
      }
      return false;
    });

    if (grantApplied) {
      // PR #470 review fix: the jsonb_set update above only mutates the
      // __accessUsers field directly -- without this, the auto-granted user
      // gets no ticket-timeline entry and no access.granted notification,
      // unlike every other access-grant path in the app (grant-access.ts,
      // resolve-access-request.ts). emitAccessEvent is itself best-effort
      // (swallows its own errors), so a failure here never turns an
      // already-successful grant into a failed job.
      await emitAccessEvent(tenantId, ticketId, actingPersonId, {
        type: "access_grant",
        targetUserId: grantedUserId,
        level: "read_only",
        tag: "mention",
      });
    }
  },
  { connection, concurrency: 4 },
);

mentionResolutionWorker.on("failed", (job, err) => {
  if (!job) return;
  const { tenantId, ticketId, mentionIdentifier, actingPersonId, commentId } =
    job.data;
  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);

  logger.error(
    { tenantId, ticketId, attempt: job.attemptsMade, err: String(err) },
    "mention-resolution: job failed",
  );

  if (isFinalAttempt) {
    void withTenantContext(tenantId, (tx) =>
      writeAuditEntry(tx, {
        tenantId,
        actorId: actingPersonId,
        actorType: "api_key",
        actingPersonId,
        resourceType: "ticket",
        resourceId: ticketId,
        action: "tag.resolution_failed",
        metadata: { commentId, mentionIdentifier, error: String(err) },
      }),
    ).catch((auditErr) => {
      logger.error(
        { tenantId, ticketId, err: String(auditErr) },
        "mention-resolution: failed to write resolution_failed audit entry",
      );
    });
  }
});

export async function stopMentionResolutionWorker(): Promise<void> {
  await mentionResolutionWorker.close();
}
