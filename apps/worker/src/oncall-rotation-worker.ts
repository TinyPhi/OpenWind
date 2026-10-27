/**
 * Recurring on-call roster -- docs/specs/oncall-team-rotation.md R5-R8, ADR-016 addendum A2-A4.
 *
 * Polls active rotations across all tenants (through the narrow oncall_rotation_sweeper role, which
 * can only READ six columns of on_call_rotations), then does all real work per rotation inside an
 * ordinary tenant-scoped transaction where RLS applies:
 *
 *  1. generate: re-lock the rotation (FOR UPDATE SKIP LOCKED, so concurrent instances and rolling
 *     deploys never double-generate), step the pure rotation rules, insert each window, advance the
 *     cursor. A manual window that overlaps the next one blocks the rotation; it is never overwritten.
 *  2. notify: each person on a rotation window that starts within the notice lead and has not started
 *     gets one in-app notification and the usual email, claimed through a unique (window, person,
 *     role) row so it happens at most once. A failed notice is logged and retried on the next run, and
 *     never blocks generation.
 */

import { and, asc, eq, gt, isNotNull, isNull, lt, lte } from "drizzle-orm";
import {
  db,
  withTenantContext,
  setOncallRotationSweeperRole,
  onCallRotations,
  onCallSchedules,
  onCallScheduleNotices,
  notifications,
  notificationRecipients,
  teams,
  isOutboundNotificationsEnabled,
} from "@platform/db";
import {
  planWindows,
  loadTeamMemberIds,
  loadPreviousHolders,
  ROTATION_NOTICE_LEAD_MS,
} from "@platform/teams";
import { writeAuditEntry } from "@platform/audit";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { getRedis, NOTIFICATION_PUSH_CHANNEL } from "@platform/redis";
import { notifyOutboundQueue } from "./queues.js";
import { validateActiveTenant } from "./tenant-guard.js";

const WORKER_NAME = "oncall-rotation";
const SYSTEM_ACTOR = "system:oncall-rotation-worker";
const NOTICE_TYPE = "oncall.rotation_notice";
const TICK_INTERVAL_MS = env.ONCALL_ROTATION_TICK_INTERVAL_SECONDS * 1000;

const NO_MEMBERS_REASON =
  "This team has no members, so no further windows can be made";

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;

type NoticeRole = "primary" | "backup" | "escalation_manager";

const ROLE_PHRASE: Record<NoticeRole, string> = {
  primary: "primary on call",
  backup: "backup on call",
  escalation_manager: "the escalation manager",
};

function utcStamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// Same sanitising as notification-templates.ts: names go into a channel with no read check of its own.
function plain(value: string): string {
  return value.replace(/[<>]/g, "");
}

interface GenerationResult {
  windowsCreated: number;
  blocked: boolean;
  capped: boolean;
}

async function generateForRotation(
  tenantId: string,
  rotationId: string,
  now: Date,
): Promise<GenerationResult> {
  return withTenantContext(tenantId, async (tx) => {
    const idle: GenerationResult = {
      windowsCreated: 0,
      blocked: false,
      capped: false,
    };
    const [rotation] = await tx
      .select()
      .from(onCallRotations)
      .where(
        and(
          eq(onCallRotations.id, rotationId),
          eq(onCallRotations.tenantId, tenantId),
          eq(onCallRotations.status, "active"),
        ),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    if (!rotation) return idle; // stopped meanwhile, or another instance holds it

    const [team] = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(
        and(
          eq(teams.id, rotation.teamId),
          eq(teams.tenantId, tenantId),
          isNull(teams.deletedAt),
        ),
      )
      .limit(1);
    if (!team) return idle; // nothing is generated for a deleted team

    const members = await loadTeamMemberIds(tx, tenantId, rotation.teamId);
    const previous = await loadPreviousHolders(tx, tenantId, rotation);
    const plan = planWindows({
      members,
      cycleDays: rotation.cycleDays,
      nextStartsAt: rotation.nextStartsAt,
      previous,
      escalationManager: rotation.escalationManagerUserId,
      now,
      endsOn: rotation.endsOn,
    });

    // A manual window overlapping one we would create stops generation at that window.
    let blockedAt = -1;
    let overlapReason: string | null = null;
    for (const [i, w] of plan.windows.entries()) {
      const [clash] = await tx
        .select({
          label: onCallSchedules.label,
          startsAt: onCallSchedules.startsAt,
          endsAt: onCallSchedules.endsAt,
        })
        .from(onCallSchedules)
        .where(
          and(
            eq(onCallSchedules.tenantId, tenantId),
            eq(onCallSchedules.teamId, rotation.teamId),
            isNull(onCallSchedules.deletedAt),
            lt(onCallSchedules.startsAt, w.endsAt),
            gt(onCallSchedules.endsAt, w.startsAt),
          ),
        )
        .limit(1);
      if (clash) {
        blockedAt = i;
        overlapReason = `The window "${clash.label}" (${utcStamp(clash.startsAt)} to ${utcStamp(clash.endsAt)}) overlaps the next window, which would start ${utcStamp(w.startsAt)}. Remove or move it to resume.`;
        break;
      }
    }

    const toCreate =
      blockedAt === -1 ? plan.windows : plan.windows.slice(0, blockedAt);
    let created = 0;
    for (const w of toCreate) {
      const [row] = await tx
        .insert(onCallSchedules)
        .values({
          tenantId,
          teamId: rotation.teamId,
          rotationId: rotation.id,
          label: `Rotation ${w.startsAt.toISOString().slice(0, 10)}`,
          startsAt: w.startsAt,
          endsAt: w.endsAt,
          primaryUserId: w.primary,
          backupUserId: w.backup,
          escalationManagerUserId: w.escalationManager,
          createdBy: rotation.createdBy,
        })
        // Name the (rotation_id, starts_at) guard. A bare ON CONFLICT DO NOTHING would also swallow the
        // no-overlap exclusion error, so a manual window created after the clash check above would
        // silently skip a cycle; as an error it rolls back and the next run blocks on the clash.
        .onConflictDoNothing({
          target: [onCallSchedules.rotationId, onCallSchedules.startsAt],
          where: isNotNull(onCallSchedules.rotationId),
        })
        .returning();
      if (!row) continue; // already generated: the unique (rotation_id, starts_at) guard held
      created++;
      await writeAuditEntry(tx, {
        tenantId,
        actorId: SYSTEM_ACTOR,
        actorType: "system",
        resourceType: "on_call_schedule",
        resourceId: row.id,
        action: "created",
        afterSnapshot: {
          teamId: row.teamId,
          rotationId: rotation.id,
          label: row.label,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          primaryUserId: row.primaryUserId,
          backupUserId: row.backupUserId,
          escalationManagerUserId: row.escalationManagerUserId,
          ownerUserId: rotation.createdBy,
        },
      });
    }

    // Where generation continues. A block at the very first planned window leaves the cursor alone
    // (skipped cycles are deterministic and are simply re-planned); a later block continues from
    // the last window actually created.
    let cursor = {
      nextStartsAt: rotation.nextStartsAt,
      lastPrimary: rotation.lastPrimaryUserId,
      lastBackup: rotation.lastBackupUserId,
    };
    if (blockedAt === -1) {
      cursor = {
        nextStartsAt: plan.cursor.nextStartsAt,
        lastPrimary: plan.cursor.lastPrimary ?? rotation.lastPrimaryUserId,
        lastBackup: plan.cursor.lastBackup,
      };
    } else if (blockedAt > 0) {
      const last = plan.windows[blockedAt - 1];
      if (last) {
        cursor = {
          nextStartsAt: last.endsAt,
          lastPrimary: last.primary,
          lastBackup: last.backup,
        };
      }
    }

    const stepped = plan.windows.length + plan.skippedEnded > 0;
    let blockedReason = rotation.blockedReason;
    if (plan.stoppedBy === "no_members") blockedReason = NO_MEMBERS_REASON;
    else if (blockedAt !== -1) blockedReason = overlapReason;
    else if (stepped) blockedReason = null;

    const changed =
      cursor.nextStartsAt.getTime() !== rotation.nextStartsAt.getTime() ||
      cursor.lastPrimary !== rotation.lastPrimaryUserId ||
      cursor.lastBackup !== rotation.lastBackupUserId ||
      blockedReason !== rotation.blockedReason;
    if (changed) {
      await tx
        .update(onCallRotations)
        .set({
          nextStartsAt: cursor.nextStartsAt,
          lastPrimaryUserId: cursor.lastPrimary,
          lastBackupUserId: cursor.lastBackup,
          blockedReason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(onCallRotations.id, rotation.id),
            eq(onCallRotations.tenantId, tenantId),
          ),
        );
    }

    if (plan.capped) {
      logger.warn(
        {
          tenantId,
          rotationId,
          steps: plan.windows.length + plan.skippedEnded,
        },
        "oncall-rotation: step cap reached; the rest follows on the next run",
      );
    }
    if (blockedAt !== -1 && rotation.blockedReason !== blockedReason) {
      logger.warn(
        { tenantId, rotationId },
        "oncall-rotation: blocked by an overlapping window",
      );
    }
    return {
      windowsCreated: created,
      blocked: blockedReason !== null,
      capped: plan.capped,
    };
  });
}

interface NoticeTarget {
  scheduleId: string;
  userId: string;
  role: NoticeRole;
  startsAt: Date;
  endsAt: Date;
}

async function sendNoticesForRotation(
  tenantId: string,
  rotationId: string,
  now: Date,
): Promise<{ sent: number; failed: number }> {
  const { teamName, targets } = await withTenantContext(
    tenantId,
    async (tx) => {
      const [rotation] = await tx
        .select({ teamId: onCallRotations.teamId })
        .from(onCallRotations)
        .where(
          and(
            eq(onCallRotations.id, rotationId),
            eq(onCallRotations.tenantId, tenantId),
          ),
        )
        .limit(1);
      if (!rotation) return { teamName: "", targets: [] as NoticeTarget[] };
      const [team] = await tx
        .select({ name: teams.name })
        .from(teams)
        .where(and(eq(teams.id, rotation.teamId), eq(teams.tenantId, tenantId)))
        .limit(1);
      // Only windows that start within the lead and have not started: a window that has already
      // started is never announced, and one further out is announced once it gets close.
      const windows = await tx
        .select()
        .from(onCallSchedules)
        .where(
          and(
            eq(onCallSchedules.tenantId, tenantId),
            eq(onCallSchedules.rotationId, rotationId),
            isNull(onCallSchedules.deletedAt),
            gt(onCallSchedules.startsAt, now),
            lte(
              onCallSchedules.startsAt,
              new Date(now.getTime() + ROTATION_NOTICE_LEAD_MS),
            ),
          ),
        )
        .orderBy(asc(onCallSchedules.startsAt));
      const out: NoticeTarget[] = [];
      for (const w of windows) {
        const holders: [string | null, NoticeRole][] = [
          [w.primaryUserId, "primary"],
          [w.backupUserId, "backup"],
          [w.escalationManagerUserId, "escalation_manager"],
        ];
        for (const [userId, role] of holders) {
          if (userId) {
            out.push({
              scheduleId: w.id,
              userId,
              role,
              startsAt: w.startsAt,
              endsAt: w.endsAt,
            });
          }
        }
      }
      return { teamName: team?.name ?? "your team", targets: out };
    },
  );

  let sent = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      if (await sendOneNotice(tenantId, teamName, target)) sent++;
    } catch (err) {
      failed++;
      logger.error(
        {
          err,
          tenantId,
          rotationId,
          scheduleId: target.scheduleId,
          role: target.role,
        },
        "oncall-rotation: notice failed; it will be retried on the next run",
      );
    }
  }
  return { sent, failed };
}

/** Returns true when a notice was sent, false when it was already sent. */
async function sendOneNotice(
  tenantId: string,
  teamName: string,
  target: NoticeTarget,
): Promise<boolean> {
  const title = "On-call rotation";
  const body = `You will be ${ROLE_PHRASE[target.role]} for ${plain(teamName)} from ${utcStamp(target.startsAt)} to ${utcStamp(target.endsAt)}`;

  // The claim row and the notification commit together: if the notification cannot be written the
  // claim rolls back too, so the next run tries again instead of silently losing the notice.
  const created = await withTenantContext(tenantId, async (tx) => {
    const claimed = await tx
      .insert(onCallScheduleNotices)
      .values({
        tenantId,
        scheduleId: target.scheduleId,
        userId: target.userId,
        role: target.role,
      })
      .onConflictDoNothing()
      .returning({ id: onCallScheduleNotices.id });
    if (claimed.length === 0) return null;
    const [notification] = await tx
      .insert(notifications)
      .values({ tenantId, type: NOTICE_TYPE, title, body, link: null })
      .returning({ id: notifications.id, createdAt: notifications.createdAt });
    if (!notification) throw new Error("notifications insert returned no row");
    await tx.insert(notificationRecipients).values({
      notificationId: notification.id,
      tenantId,
      userId: target.userId,
    });
    return notification;
  });
  if (!created) return false;

  // After commit and best-effort, like every other notification producer.
  await getRedis()
    .publish(
      NOTIFICATION_PUSH_CHANNEL,
      JSON.stringify({
        tenantId,
        userId: target.userId,
        notification: {
          id: created.id,
          type: NOTICE_TYPE,
          title,
          body,
          link: null,
          createdAt: created.createdAt.toISOString(),
        },
      }),
    )
    .catch((err: unknown) => {
      logger.warn(
        { err, tenantId, notificationId: created.id },
        "oncall-rotation: failed to publish live push",
      );
    });
  if (await isOutboundNotificationsEnabled()) {
    await notifyOutboundQueue
      .add(
        "dispatch",
        { notificationId: created.id, tenantId },
        { jobId: created.id },
      )
      .catch((err: unknown) => {
        logger.error(
          { err, tenantId, notificationId: created.id },
          "oncall-rotation: failed to enqueue the outbound email",
        );
      });
  }
  return true;
}

export async function rotationTick(now: Date = new Date()): Promise<void> {
  try {
    // Cross-tenant discovery only: RLS hides rotations from a worker with no tenant context, so
    // this one read goes through the sweeper role. Everything after runs tenant-scoped.
    const rotations = await db.transaction(async (tx) => {
      await setOncallRotationSweeperRole(tx);
      return tx
        .select({
          id: onCallRotations.id,
          tenantId: onCallRotations.tenantId,
        })
        .from(onCallRotations)
        .where(eq(onCallRotations.status, "active"));
    });

    const eligibility = new Map<string, boolean>();
    let windowsCreated = 0;
    let noticesSent = 0;
    let failed = 0;
    let skippedIneligible = 0;

    for (const r of rotations) {
      let eligible = eligibility.get(r.tenantId);
      if (eligible === undefined) {
        eligible = await validateActiveTenant(r.tenantId, WORKER_NAME, {
          rotationId: r.id,
        });
        eligibility.set(r.tenantId, eligible);
      }
      if (!eligible) {
        skippedIneligible++;
        continue;
      }
      try {
        const generated = await generateForRotation(r.tenantId, r.id, now);
        windowsCreated += generated.windowsCreated;
      } catch (err) {
        failed++;
        logger.error(
          { err, tenantId: r.tenantId, rotationId: r.id },
          "oncall-rotation: generation failed",
        );
        continue;
      }
      try {
        const notices = await sendNoticesForRotation(r.tenantId, r.id, now);
        noticesSent += notices.sent;
        failed += notices.failed;
      } catch (err) {
        failed++;
        logger.error(
          { err, tenantId: r.tenantId, rotationId: r.id },
          "oncall-rotation: notice pass failed",
        );
      }
    }

    logger.info(
      {
        rotations: rotations.length,
        windowsCreated,
        noticesSent,
        failed,
        skippedIneligible,
      },
      "oncall-rotation tick complete",
    );
  } catch (err) {
    logger.error({ err }, "oncall-rotation tick failed");
  }
}

export function startOncallRotationWorker(
  intervalMs: number = TICK_INTERVAL_MS,
): void {
  if (pollTimer) return;
  activeTick = rotationTick().finally(() => {
    activeTick = null;
  });
  pollTimer = setInterval(() => {
    if (activeTick) return; // previous tick still running
    activeTick = rotationTick().finally(() => {
      activeTick = null;
    });
  }, intervalMs);
  logger.info({ intervalMs }, "Oncall rotation worker started");
}

export async function stopOncallRotationWorker(): Promise<void> {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (activeTick) {
    await activeTick;
    activeTick = null;
  }
  logger.info({}, "Oncall rotation worker stopped");
}
