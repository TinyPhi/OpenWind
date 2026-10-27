import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  onCallSchedules,
  teamMembers,
  type DbOrTx,
  type onCallRotations,
} from "@platform/db";
import type { RotationHolders } from "./rotation.js";

type RotationCursor = Pick<
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
