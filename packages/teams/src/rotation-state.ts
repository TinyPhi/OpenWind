import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  onCallSchedules,
  teamMembers,
  type DbOrTx,
  type onCallRotations,
} from "@platform/db";
import type { RotationHolders } from "./rotation.js";

export type RotationCursor = Pick<
  typeof onCallRotations.$inferSelect,
  "id" | "lastPrimaryUserId" | "lastBackupUserId"
>;

/** A team's members in rotation order. */
export async function loadTeamMemberIds(
  tx: DbOrTx,
  tenantId: string,
  teamId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(
      and(eq(teamMembers.tenantId, tenantId), eq(teamMembers.teamId, teamId)),
    )
    .orderBy(asc(teamMembers.position));
  return rows.map((r) => r.userId);
}

/**
 * Multiple teams' members in rotation order, batched in a single query (#1163).
 * Every requested teamId is mapped to its members array (or an empty array if none).
 */
export async function loadTeamMemberIdsBatch(
  tx: DbOrTx,
  tenantId: string,
  teamIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (teamIds.length === 0) return result;

  for (const id of teamIds) {
    result.set(id, []);
  }

  const rows = await tx
    .select({
      teamId: teamMembers.teamId,
      userId: teamMembers.userId,
    })
    .from(teamMembers)
    .where(
      and(
        eq(teamMembers.tenantId, tenantId),
        inArray(teamMembers.teamId, [...teamIds]),
      ),
    )
    .orderBy(asc(teamMembers.position));

  for (const r of rows) {
    result.get(r.teamId)?.push(r.userId);
  }

  return result;
}

/**
 * Who held the roles last (R5): the rotation's latest window that still exists,
 * so an admin's edit to it carries forward; the stored cursor when none exists.
 * A deleted window is skipped, so it neither blocks nor is regenerated.
 */
export async function loadPreviousHolders(
  tx: DbOrTx,
  tenantId: string,
  rotation: RotationCursor,
): Promise<RotationHolders> {
  const [latest] = await tx
    .select({
      primary: onCallSchedules.primaryUserId,
      backup: onCallSchedules.backupUserId,
    })
    .from(onCallSchedules)
    .where(
      and(
        eq(onCallSchedules.tenantId, tenantId),
        eq(onCallSchedules.rotationId, rotation.id),
        isNull(onCallSchedules.deletedAt),
      ),
    )
    .orderBy(desc(onCallSchedules.startsAt))
    .limit(1);
  if (latest) return { primary: latest.primary, backup: latest.backup };
  return {
    primary: rotation.lastPrimaryUserId,
    backup: rotation.lastBackupUserId,
  };
}

/**
 * Who held the roles last across multiple rotations, batched in a single query (#1163).
 * Fetches the latest non-deleted schedule for each rotation (if any), falling back to
 * the stored cursor values on the rotation row.
 */
export async function loadPreviousHoldersBatch(
  tx: DbOrTx,
  tenantId: string,
  rotations: readonly RotationCursor[],
): Promise<Map<string, RotationHolders>> {
  const result = new Map<string, RotationHolders>();
  if (rotations.length === 0) return result;

  const rotationIds = rotations.map((r) => r.id);
  const schedules = await tx
    .select({
      rotationId: onCallSchedules.rotationId,
      primary: onCallSchedules.primaryUserId,
      backup: onCallSchedules.backupUserId,
    })
    .from(onCallSchedules)
    .where(
      and(
        eq(onCallSchedules.tenantId, tenantId),
        inArray(onCallSchedules.rotationId, rotationIds),
        isNull(onCallSchedules.deletedAt),
      ),
    )
    .orderBy(desc(onCallSchedules.startsAt));

  for (const s of schedules) {
    if (s.rotationId && !result.has(s.rotationId)) {
      result.set(s.rotationId, {
        primary: s.primary,
        backup: s.backup,
      });
    }
  }

  for (const r of rotations) {
    if (!result.has(r.id)) {
      result.set(r.id, {
        primary: r.lastPrimaryUserId,
        backup: r.lastBackupUserId,
      });
    }
  }

  return result;
}
