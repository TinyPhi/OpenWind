import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { and, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import {
  entityInstances,
  teams,
  notifications,
  notificationRecipients,
  isOutboundNotificationsEnabled,
} from "@platform/db";
import { updateEntity } from "@platform/entity-engine";
import {
  getActiveScheduleForTeam,
  resolveOncallCascade,
} from "@platform/teams";
import { getWorkflowByEntityTypeId } from "@platform/workflow-engine";
import { writeAuditEntry } from "@platform/audit";
import { Queue, oncallResolutionsTotal } from "@platform/telemetry";
import { logger } from "@platform/logger";
import type { TriggerEvent } from "../event-schemas.js";
import type { ResolveOncallConfig } from "../types.js";
import { postOncallComment } from "./post-oncall-comment.js";

export type { ResolveOncallConfig };

type InstanceContext = {
  entityTypeId: string;
  workflowId: string | null;
  currentState: string;
};

async function getInstanceContext(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
): Promise<InstanceContext | null> {
  const [row] = await db
    .select({
      entityTypeId: entityInstances.entityTypeId,
      workflowId: entityInstances.workflowId,
      currentState: entityInstances.currentState,
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
  return row ?? null;
}

/**
 * docs/specs/team-assign-oncall-fallback.md R4 — the cascade's final,
 * last-resort tier: the ticket's workflow admin (ADR-006 — `createdBy` is
 * always the implicit admin; "first found" per the accepted design, no need
 * to also consult `assignedTo[]`). `getWorkflowByEntityTypeId` already
 * orders by `createdAt` (issue #168's fix), so this resolution is
 * deterministic even if more than one workflow row ever governed the same
 * entity type. Returns null (cascade fully exhausted) when the entity type
 * has no governing workflow, or that workflow has no createdBy.
 */
async function resolveWorkflowAdminFallback(
  db: DbOrTx,
  tenantId: string,
  entityTypeId: string,
): Promise<string | null> {
  const workflow = await getWorkflowByEntityTypeId(db, tenantId, entityTypeId);
  return workflow?.createdBy ?? null;
}

/**
 * Called from both of resolve_oncall's fail-open exits (no active schedule
 * at all, and an exhausted schedule cascade) — docs/specs/
 * team-assign-oncall-fallback.md R4 treats these as one "the cascade
 * produced nobody" case, both now trying the workflow-admin fallback before
 * truly failing open. Also posts the single R5 summary comment for
 * whichever terminal outcome this call reaches (assigned via fallback, or
 * genuinely fail-open) — the ONE place both fail-open paths convergently
 * post through, so "exactly one comment" doesn't need separate proof at
 * each call site.
 */
async function handleCascadeMiss(
  db: DbOrTx,
  tenantId: string,
  instanceId: string,
  teamId: string,
  teamName: string,
  depth: number,
  redis: Redis | undefined,
  scheduleInfo: { scheduleId: string | undefined; cascadeExhausted: boolean },
): Promise<void> {
  const { scheduleId, cascadeExhausted } = scheduleInfo;
  const instanceCtx = await getInstanceContext(db, tenantId, instanceId);
  const adminUserId = instanceCtx
    ? await resolveWorkflowAdminFallback(db, tenantId, instanceCtx.entityTypeId)
    : null;

  if (adminUserId) {
    await updateEntity(db, tenantId, instanceId, {
      assignedTo: adminUserId,
      depth,
    });
    await writeAuditEntry(db, {
      tenantId,
      actorId: "system",
      actorType: "system",
      resourceType: "ticket",
      resourceId: instanceId,
      action: "oncall.auto_assigned",
      metadata: {
        teamId,
        scheduleId,
        cascadeExhausted,
        assignedTier: "workflow_admin",
        assignedUserId: adminUserId,
      },
    });
    oncallResolutionsTotal.add(1, {
      outcome: "auto_assigned",
      assigned_tier: "workflow_admin",
      cascade_exhausted: String(cascadeExhausted),
    });
    if (redis) await redis.srem(`oncall:coverage_gap:${tenantId}`, teamId);
    if (instanceCtx) {
      await postOncallComment(db, {
        tenantId,
        instanceId,
        workflowId: instanceCtx.workflowId,
        currentState: instanceCtx.currentState,
        text: `No primary/backup/escalation coverage found for team ${teamName} — auto-assigned to workflow admin.`,
      });
    }
    logger.info(
      { tenantId, instanceId, teamId, assignedTier: "workflow_admin" },
      "Automation: resolve_oncall assigned ticket via workflow-admin fallback",
    );
    return;
  }

  await writeAuditEntry(db, {
    tenantId,
    actorId: "system",
    actorType: "system",
    resourceType: "ticket",
    resourceId: instanceId,
    action: "oncall.no_schedule",
    metadata: { teamId, scheduleId, cascadeExhausted },
  });
  oncallResolutionsTotal.add(1, {
    outcome: "no_schedule",
    assigned_tier: "none",
    cascade_exhausted: String(cascadeExhausted),
  });
  if (redis) await redis.sadd(`oncall:coverage_gap:${tenantId}`, teamId);
  if (instanceCtx) {
    await postOncallComment(db, {
      tenantId,
      instanceId,
      workflowId: instanceCtx.workflowId,
      currentState: instanceCtx.currentState,
      text: `No on-call coverage configured for team ${teamName}, and no workflow admin could be resolved — ticket left unassigned.`,
    });
  }
}

/**
 * docs/specs/oncall-routing.md R8/R8b/R9/R10/R11 — resolves the on-call
 * cascade (primary -> backup -> escalation, R8b) for a ticket whose team_id
 * was just set or changed, and auto-assigns it. Fires on entity.created
 * (team_id present at creation) and entity.updated (team_id changed) — see
 * event-schemas.ts's EntityUpdatedV1Schema comment for why this condition
 * lives in the action itself rather than a ConditionTree operator.
 *
 * KNOWN PREREQUISITE GAP (tracked separately, not this PR's scope): the
 * ticket entity type does not yet ship team_id/service_id as seeded entity
 * fields (modules/helpdesk/seed/001_entity_types.sql's header comment —
 * blocked on the entity-engine -> teams dependency-direction question for
 * validateEntityRefs' entity_ref dispatch). This action works correctly
 * against whatever team_id value is present in the entity's fields once
 * that seeding lands; it does not depend on team_id being a *declared*
 * entity field.
 */
export async function executeResolveOncallAction(
  db: DbOrTx,
  tenantId: string,
  ruleId: string,
  execId: string,
  event: TriggerEvent,
  config: ResolveOncallConfig,
  depth: number,
  redis?: Redis,
  outboxEventId?: string,
): Promise<void> {
  const instanceId =
    config.instanceId ?? ("instanceId" in event ? event.instanceId : undefined);
  if (!instanceId) return;

  // Determine the team_id this event set, and whether an explicit assignee
  // was submitted in the SAME request (R10 — explicit-assignee-wins).
  let teamId: string | undefined;
  let explicitAssigneeInThisRequest = false;

  if (event.eventType === "entity.updated") {
    // event.changed is optional (Vijit review, PR #597 B1) -- a pre-existing
    // outbox row written before entity.updated carried this field never has
    // it, and that's not our concern, same as team_id genuinely not changing.
    if (!event.changed) return;
    const teamChange = event.changed["team_id"];
    if (!teamChange || typeof teamChange.new !== "string" || !teamChange.new) {
      return; // team_id didn't change in this event — not our concern
    }
    teamId = teamChange.new;
    explicitAssigneeInThisRequest = "assignedTo" in event.changed;
  } else if (event.eventType === "entity.created") {
    const created = event.fields["team_id"];
    if (typeof created !== "string" || !created) return;
    teamId = created;

    // entity.created carries no assignedTo — a ticket's assignedTo is always
    // null at insert time unless the create payload explicitly set it, so a
    // non-null value here can only mean it was explicit in this request.
    const [row] = await db
      .select({ assignedTo: entityInstances.assignedTo })
      .from(entityInstances)
      .where(
        and(
          eq(entityInstances.id, instanceId),
          eq(entityInstances.tenantId, tenantId),
          isNull(entityInstances.deletedAt),
        ),
      )
      .limit(1);
    explicitAssigneeInThisRequest = Boolean(row?.assignedTo);
  } else {
    return;
  }

  if (!teamId) return;

  // /security-review finding, 2026-09-21 -- unlike POST /entities' top-level
  // `teamId` param (validated against a real, same-tenant `teams` row before
  // this action ever runs), `team_id` reaching this action via PATCH
  // /entities/:id's free-form `fields` object, or via `fields.team_id` set
  // directly on create, is NOT pre-validated anywhere upstream. Without this
  // check, an arbitrary attacker-chosen string would flow into the schedule
  // lookup (harmlessly finding no match), then into audit metadata and a
  // persisted workflow comment via postOncallComment, unescaped. Re-validate
  // here -- the one chokepoint both the create and update paths funnel
  // through -- and silently no-op for a bogus/cross-tenant team_id, exactly
  // as if team_id had never been set (never surfaced in audit/comment output).
  const [teamRow] = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(
      and(
        eq(teams.id, teamId),
        eq(teams.tenantId, tenantId),
        isNull(teams.deletedAt),
      ),
    )
    .limit(1);
  if (!teamRow) return;
  // Human-readable team name for the summary comment (R5) -- audit metadata
  // below still keys on teamId (stable, joinable); the comment is the one
  // place a raw UUID would be confusing to read.
  const teamName = teamRow.name;

  // R11 idempotency — re-delivering the same event (BullMQ retry, worker
  // restart replay) for an unchanged (instanceId, teamId) pair must not
  // duplicate ANY of this action's outcomes, including the early-return
  // explicit-assignee-wins and no-schedule paths below (PR #597 review,
  // B1 — claiming this key only on the happy path let a retry write a
  // second oncall.skipped_explicit_assignee row). Keyed exactly as the
  // design doc prescribes (docs/oncall-routing-design.md §3.1) — a
  // SUBSEQUENT change to a different team_id produces a new key and
  // legitimately re-fires. Not tenant-prefixed like the coverage-gap key
  // below: instanceId is a globally-unique entity_instances.id (UUID PK,
  // never tenant-scoped or sequential), so a cross-tenant collision is
  // cryptographically negligible, not a real attack surface (security
  // review, informational).
  const idempotencyKey = `oncall_resolve:${instanceId}:${teamId}`;
  if (redis) {
    const claimed = await redis.set(idempotencyKey, "1", "EX", 86400, "NX");
    if (claimed !== "OK") {
      logger.info(
        { tenantId, instanceId, teamId },
        "Automation: resolve_oncall skipped — already processed for this (ticket, team) pair",
      );
      return;
    }
  } else {
    logger.warn(
      { tenantId, instanceId },
      "Automation: resolve_oncall running without redis — idempotency guard disabled",
    );
  }

  if (explicitAssigneeInThisRequest) {
    await writeAuditEntry(db, {
      tenantId,
      actorId: "system",
      actorType: "system",
      resourceType: "ticket",
      resourceId: instanceId,
      action: "oncall.skipped_explicit_assignee",
      metadata: { teamId },
    });
    oncallResolutionsTotal.add(1, {
      outcome: "skipped_explicit_assignee",
      assigned_tier: "none",
      cascade_exhausted: "false",
    });
    return;
  }

  const schedule = await getActiveScheduleForTeam(
    db,
    tenantId,
    teamId,
    new Date(),
  );

  if (!schedule) {
    await handleCascadeMiss(
      db,
      tenantId,
      instanceId,
      teamId,
      teamName,
      depth,
      redis,
      { scheduleId: undefined, cascadeExhausted: false },
    );
    return;
  }

  // R8b cascade: primary -> backup -> escalation, skipping unresolvable
  // tiers. Exhausted cascade (every tier unresolvable) now falls through to
  // the workflow-admin fallback tier (docs/specs/team-assign-oncall-fallback.md
  // R4) before being treated as fully fail-open.
  const resolved = await resolveOncallCascade(db, tenantId, schedule);
  if (!resolved.tier) {
    await handleCascadeMiss(
      db,
      tenantId,
      instanceId,
      teamId,
      teamName,
      depth,
      redis,
      { scheduleId: schedule.id, cascadeExhausted: true },
    );
    return;
  }

  await updateEntity(db, tenantId, instanceId, {
    assignedTo: resolved.userId,
    depth,
  });

  await writeAuditEntry(db, {
    tenantId,
    actorId: "system",
    actorType: "system",
    resourceType: "ticket",
    resourceId: instanceId,
    action: "oncall.auto_assigned",
    metadata: {
      teamId,
      scheduleId: schedule.id,
      primaryUserId: schedule.primaryUserId,
      backupUserId: schedule.backupUserId,
      assignedTier: resolved.tier,
      assignedUserId: resolved.userId,
    },
  });
  oncallResolutionsTotal.add(1, {
    outcome: "auto_assigned",
    assigned_tier: resolved.tier,
    cascade_exhausted: "false",
  });
  if (redis) await redis.srem(`oncall:coverage_gap:${tenantId}`, teamId);

  const instanceCtx = await getInstanceContext(db, tenantId, instanceId);
  if (instanceCtx) {
    await postOncallComment(db, {
      tenantId,
      instanceId,
      workflowId: instanceCtx.workflowId,
      currentState: instanceCtx.currentState,
      text: `Auto-assigned to the on-call ${resolved.tier} for team ${teamName}.`,
    });
  }

  // Backup on-call notification — same in-app notification pattern as
  // actions/notify.ts (direct table insert, same tx; outbound handoff
  // enqueued after). Only when a backup exists AND the resolved tier isn't
  // already the backup (no point notifying someone of their own assignment
  // twice through two different code paths).
  if (schedule.backupUserId && resolved.tier !== "backup") {
    const notificationId = deriveResolveOncallNotificationId(
      tenantId,
      ruleId,
      outboxEventId ?? execId,
      schedule.backupUserId,
    );

    await db
      .insert(notifications)
      .values({
        id: notificationId,
        tenantId,
        type: "oncall.backup_tagged",
        title: "You're backup on-call for an assigned ticket",
        body: `Ticket assigned to the on-call ${resolved.tier} for your team.`,
        link: `/tickets/${instanceId}`,
      })
      .onConflictDoNothing();

    await db
      .insert(notificationRecipients)
      .values({
        notificationId,
        tenantId,
        userId: schedule.backupUserId,
      })
      .onConflictDoNothing();

    if (redis && (await isOutboundNotificationsEnabled())) {
      const queue = new Queue("notify-outbound", { connection: redis });
      try {
        await queue
          .add(
            "dispatch",
            { notificationId, tenantId },
            { jobId: notificationId },
          )
          .catch((err: unknown) => {
            logger.error(
              { err, tenantId, notificationId },
              "Automation: failed to enqueue backup on-call notification outbound handoff",
            );
          });
      } finally {
        await queue.close();
      }
    }
  }

  logger.info(
    { tenantId, instanceId, teamId, assignedTier: resolved.tier },
    "Automation: resolve_oncall assigned ticket",
  );
}

function deriveResolveOncallNotificationId(
  tenantId: string,
  ruleId: string,
  jobEventId: string,
  recipientId: string,
): string {
  const hash = createHash("sha256")
    .update(
      ["resolve_oncall", tenantId, ruleId, jobEventId, recipientId].join(":"),
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
