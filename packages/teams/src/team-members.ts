import { and, asc, eq } from "drizzle-orm";
import { teamMembers, teams, type DbOrTx } from "@platform/db";

// Serializes concurrent member edits of one team: a second writer waits here
// instead of colliding on the (team_id, position) unique index afterwards.
async function lockTeam(
  tx: DbOrTx,
  tenantId: string,
  teamId: string,
): Promise<void> {
  await tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId)))
    .for("update");
}

/**
 * Re-numbers a team's members to 0..n-1 in their current order. The rotation
 * steps through members by position, so a removal must close the gap.
 * Renumbering only moves rows to lower, already-vacated positions, in
 * ascending order, so the unique (team_id, position) index never collides.
 */
export async function compactTeamPositions(
  tx: DbOrTx,
  tenantId: string,
  teamId: string,
): Promise<void> {
  await lockTeam(tx, tenantId, teamId);
  const rows = await tx
    .select({ id: teamMembers.id, position: teamMembers.position })
    .from(teamMembers)
    .where(
      and(eq(teamMembers.tenantId, tenantId), eq(teamMembers.teamId, teamId)),
    )
    .orderBy(asc(teamMembers.position));
  for (const [index, row] of rows.entries()) {
    if (row.position === index) continue;
    await tx
      .update(teamMembers)
      .set({ position: index })
      .where(
        and(eq(teamMembers.tenantId, tenantId), eq(teamMembers.id, row.id)),
      );
  }
}

/**
 * Replaces a team's ordered member list; positions come out contiguous from 0.
 * Callers validate eligibility, duplicates and the size cap first.
 */
export async function replaceTeamMembers(
  tx: DbOrTx,
  tenantId: string,
  teamId: string,
  userIds: readonly string[],
): Promise<void> {
  await lockTeam(tx, tenantId, teamId);
  await tx
    .delete(teamMembers)
    .where(
      and(eq(teamMembers.tenantId, tenantId), eq(teamMembers.teamId, teamId)),
    );
  if (userIds.length === 0) return;
  await tx.insert(teamMembers).values(
    userIds.map((userId, position) => ({
      tenantId,
      teamId,
      userId,
      position,
    })),
  );
}
