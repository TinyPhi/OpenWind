/**
 * Tenant isolation + overlap-constraint tests for the on_call_schedules table.
 *
 * docs/specs/oncall-routing.md T3, R5, R12 -- 3E on-call routing, Phase 1.
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { db, withTenantContext, onCallSchedules, teams } from "@platform/db";

const TENANT_A = "aaaaaaaa-5555-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-5555-4000-b000-000000000002";
const USER_A = "aaaaaaaa-5555-4000-a000-000000000900";
const USER_B = "bbbbbbbb-5555-4000-b000-000000000900";

let teamAId: string;
let teamBId: string;
let scheduleAId: string;
let scheduleBId: string;

beforeAll(async () => {
  const [teamA] = await db
    .insert(teams)
    .values({ tenantId: TENANT_A, name: "On-Call Team A" })
    .returning({ id: teams.id });
  const [teamB] = await db
    .insert(teams)
    .values({ tenantId: TENANT_B, name: "On-Call Team B" })
    .returning({ id: teams.id });
  teamAId = teamA!.id;
  teamBId = teamB!.id;

  const [scheduleA] = await db
    .insert(onCallSchedules)
    .values({
      tenantId: TENANT_A,
      teamId: teamAId,
      label: "Week 1",
      startsAt: new Date("2026-10-01T00:00:00Z"),
      endsAt: new Date("2026-10-08T00:00:00Z"),
      primaryUserId: USER_A,
      createdBy: USER_A,
    })
    .returning({ id: onCallSchedules.id });
  const [scheduleB] = await db
    .insert(onCallSchedules)
    .values({
      tenantId: TENANT_B,
      teamId: teamBId,
      label: "Week 1",
      startsAt: new Date("2026-10-01T00:00:00Z"),
      endsAt: new Date("2026-10-08T00:00:00Z"),
      primaryUserId: USER_B,
      createdBy: USER_B,
    })
    .returning({ id: onCallSchedules.id });
  scheduleAId = scheduleA!.id;
  scheduleBId = scheduleB!.id;
});

afterAll(async () => {
  await db
    .delete(onCallSchedules)
    .where(eq(onCallSchedules.tenantId, TENANT_A));
  await db
    .delete(onCallSchedules)
    .where(eq(onCallSchedules.tenantId, TENANT_B));
  await db.delete(teams).where(eq(teams.tenantId, TENANT_A));
  await db.delete(teams).where(eq(teams.tenantId, TENANT_B));
});

describe("on_call_schedules — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's schedule", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: onCallSchedules.id })
        .from(onCallSchedules)
        .where(
          and(
            eq(onCallSchedules.id, scheduleBId),
            eq(onCallSchedules.tenantId, TENANT_A),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own schedule", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: onCallSchedules.id })
        .from(onCallSchedules)
        .where(eq(onCallSchedules.tenantId, TENANT_A));
      expect(rows.map((r) => r.id)).toContain(scheduleAId);
    });
  });

  it("RLS blocks a raw cross-tenant SELECT under app_user role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx
        .select({ id: onCallSchedules.id })
        .from(onCallSchedules)
        .where(eq(onCallSchedules.id, scheduleBId));
    });
    expect(rows).toHaveLength(0);
  });
});

describe("on_call_schedules — overlap constraint (R5)", () => {
  it("rejects an overlapping window for the same tenant+team pair (GIST exclusion, DB-level 409-equivalent)", async () => {
    await expect(
      db.insert(onCallSchedules).values({
        tenantId: TENANT_A,
        teamId: teamAId,
        label: "Overlapping Week",
        // Overlaps [2026-10-01, 2026-10-08) from beforeAll's scheduleA.
        startsAt: new Date("2026-10-05T00:00:00Z"),
        endsAt: new Date("2026-10-12T00:00:00Z"),
        primaryUserId: USER_A,
        createdBy: USER_A,
      }),
    ).rejects.toMatchObject({ cause: { code: "23P01" } }); // exclusion_violation
  });

  it("allows a non-overlapping window for the same tenant+team pair", async () => {
    const [row] = await db
      .insert(onCallSchedules)
      .values({
        tenantId: TENANT_A,
        teamId: teamAId,
        label: "Week 2",
        startsAt: new Date("2026-10-08T00:00:00Z"),
        endsAt: new Date("2026-10-15T00:00:00Z"),
        primaryUserId: USER_A,
        createdBy: USER_A,
      })
      .returning({ id: onCallSchedules.id });
    expect(row?.id).toBeTruthy();
  });

  it("allows the identical window for a different team in the same tenant", async () => {
    const [otherTeam] = await db
      .insert(teams)
      .values({ tenantId: TENANT_A, name: "Another Team A" })
      .returning({ id: teams.id });
    const [row] = await db
      .insert(onCallSchedules)
      .values({
        tenantId: TENANT_A,
        teamId: otherTeam!.id,
        label: "Week 1",
        startsAt: new Date("2026-10-01T00:00:00Z"),
        endsAt: new Date("2026-10-08T00:00:00Z"),
        primaryUserId: USER_A,
        createdBy: USER_A,
      })
      .returning({ id: onCallSchedules.id });
    expect(row?.id).toBeTruthy();
  });
});
