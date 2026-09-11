/**
 * On-call schedule resolution — docs/specs/oncall-routing.md R6/R8/R8b.
 *
 * Shared between apps/api/src/routes/admin/on-call-schedules.ts's `/current`
 * snapshot endpoint and packages/automation-engine's `resolve_oncall` action
 * (docs/specs/oncall-routing.md T12/T14b) — one source of truth for "is this
 * user resolvable" and the primary->backup->escalation cascade decision.
 *
 * "Resolvable" is approximated as "a tenant_users row exists for this user
 * id" — this schema has no separate deactivated-user flag (see this
 * package's callers' own comments for the same caveat).
 */

import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { onCallSchedules, tenantUsers } from "@platform/db";

export type OnCallScheduleRow = typeof onCallSchedules.$inferSelect;

/**
 * The active schedule for one team as of `now`, or null if none is active.
 * Mirrors the WHERE clause used by the route's batch `/current` query
 * (R6 hot path — indexed on tenant_id, team_id, starts_at, ends_at).
 */
export async function getActiveScheduleForTeam(
  tx: DbOrTx,
  tenantId: string,
  teamId: string,
  now: Date,
): Promise<OnCallScheduleRow | null> {
  const [row] = await tx
    .select()
    .from(onCallSchedules)
    .where(
      and(
        eq(onCallSchedules.tenantId, tenantId),
        eq(onCallSchedules.teamId, teamId),
        isNull(onCallSchedules.deletedAt),
        lte(onCallSchedules.startsAt, now),
        gt(onCallSchedules.endsAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Batch resolvability check, scoped to the specific ids being asked about —
 * never a full tenant_users scan (PR #590 review, G2/B4's lesson).
 */
export async function getUsersResolvableSet(
  tx: DbOrTx,
  tenantId: string,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx
    .select({ userId: tenantUsers.userId })
    .from(tenantUsers)
    .where(
      and(
        eq(tenantUsers.tenantId, tenantId),
        inArray(tenantUsers.userId, userIds),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

export async function isUserResolvable(
  tx: DbOrTx,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const resolvable = await getUsersResolvableSet(tx, tenantId, [userId]);
  return resolvable.has(userId);
}

export type ResolvedOncallUser = {
  userId: string;
  displayName: string | null;
  reason?: "referenced_user_deleted";
};

/**
 * Pure classification given a pre-fetched display-name map — the route's
 * `/current` handler builds this map itself via one batched query across all
 * teams' schedules, since it needs displayName too (not just resolvability).
 * Extracted so both call sites agree on exactly what "unresolvable" means.
 */
export function classifyOncallUser(
  userId: string | null,
  displayName: string | null | undefined,
): ResolvedOncallUser | null {
  if (!userId) return null;
  if (displayName === undefined || displayName === null) {
    return { userId, displayName: null, reason: "referenced_user_deleted" };
  }
  return { userId, displayName };
}

export type OncallTier = "primary" | "backup" | "escalation";

export type CascadeResult =
  | { tier: OncallTier; userId: string }
  | { tier: null; userId: null };

/**
 * Resolves the on-call cascade for a single active schedule: primary ->
 * backup -> escalation, skipping any tier whose user is unresolvable
 * (docs/specs/oncall-routing.md R8b). One batched resolvability query for
 * the schedule's (up to 3) referenced user ids, not one query per tier.
 * Returns {tier: null, userId: null} when no tier is populated or every
 * populated tier is unresolvable — callers treat this identically to "no
 * schedule at all" (R9/R8b fail-open parity — see resolve-oncall.ts).
 */
export async function resolveOncallCascade(
  tx: DbOrTx,
  tenantId: string,
  schedule: OnCallScheduleRow,
): Promise<CascadeResult> {
  const candidates: Array<{ tier: OncallTier; userId: string | null }> = [
    { tier: "primary", userId: schedule.primaryUserId },
    { tier: "backup", userId: schedule.backupUserId },
    { tier: "escalation", userId: schedule.escalationManagerUserId },
  ];
  const candidateIds = candidates
    .map((c) => c.userId)
    .filter((id): id is string => Boolean(id));
  const resolvable = await getUsersResolvableSet(tx, tenantId, candidateIds);

  for (const c of candidates) {
    if (c.userId && resolvable.has(c.userId)) {
      return { tier: c.tier, userId: c.userId };
    }
  }
  return { tier: null, userId: null };
}
