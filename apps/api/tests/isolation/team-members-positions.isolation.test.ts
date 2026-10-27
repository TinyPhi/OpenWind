/**
 * docs/specs/oncall-team-rotation.md R1: a team's member positions stay
 * contiguous from 0 when a member is removed or the list is replaced, so the
 * rotation never steps over a gap.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  tenants,
  teams,
  teamMembers,
  withTenantContext,
} from "@platform/db";
import { compactTeamPositions, replaceTeamMembers } from "@platform/teams";

const TENANT = "aaaaaaaa-1028-4000-a000-0000000000a1";
let teamId: string;

async function members(): Promise<{ userId: string; position: number }[]> {
  return withTenantContext(TENANT, (tx) =>
    tx
      .select({ userId: teamMembers.userId, position: teamMembers.position })
      .from(teamMembers)
      .where(
        and(eq(teamMembers.tenantId, TENANT), eq(teamMembers.teamId, teamId)),
      )
      .orderBy(asc(teamMembers.position)),
  );
}

describe("team member positions", () => {
  beforeAll(async () => {
    await db
      .insert(tenants)
      .values({ id: TENANT, name: "t-1028", slug: "t-1028-positions" })
      .onConflictDoNothing();
    const [team] = await db
      .insert(teams)
      .values({ tenantId: TENANT, name: "positions", createdBy: "u-admin" })
      .returning({ id: teams.id });
    teamId = team!.id;
  });

  afterAll(async () => {
    await db.delete(teamMembers).where(eq(teamMembers.tenantId, TENANT));
    await db.delete(teams).where(eq(teams.tenantId, TENANT));
    await db.delete(tenants).where(eq(tenants.id, TENANT));
  });

  it("numbers a replaced list 0..n-1 in the given order", async () => {
    await withTenantContext(TENANT, (tx) =>
      replaceTeamMembers(tx, TENANT, teamId, ["a", "b", "c", "d"]),
    );
    expect(await members()).toEqual([
      { userId: "a", position: 0 },
      { userId: "b", position: 1 },
      { userId: "c", position: 2 },
      { userId: "d", position: 3 },
    ]);
  });

  it("closes the gap when a middle member is removed", async () => {
    await withTenantContext(TENANT, async (tx) => {
      await tx
        .delete(teamMembers)
        .where(
          and(eq(teamMembers.tenantId, TENANT), eq(teamMembers.userId, "b")),
        );
      await compactTeamPositions(tx, TENANT, teamId);
    });
    expect(await members()).toEqual([
      { userId: "a", position: 0 },
      { userId: "c", position: 1 },
      { userId: "d", position: 2 },
    ]);
  });

  it("closes the gap when the first member is removed", async () => {
    await withTenantContext(TENANT, async (tx) => {
      await tx
        .delete(teamMembers)
        .where(
          and(eq(teamMembers.tenantId, TENANT), eq(teamMembers.userId, "a")),
        );
      await compactTeamPositions(tx, TENANT, teamId);
    });
    expect(await members()).toEqual([
      { userId: "c", position: 0 },
      { userId: "d", position: 1 },
    ]);
  });

  it("empties the team when replaced with no members", async () => {
    await withTenantContext(TENANT, (tx) =>
      replaceTeamMembers(tx, TENANT, teamId, []),
    );
    expect(await members()).toEqual([]);
  });
});
