/**
 * Tenant isolation tests for the teams table.
 *
 * docs/specs/oncall-routing.md T1, R3, R12 -- 3E on-call routing, Phase 1.
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { db, withTenantContext, teams } from "@platform/db";

const TENANT_A = "aaaaaaaa-3333-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-3333-4000-b000-000000000002";

let teamAId: string;
let teamBId: string;

beforeAll(async () => {
  const [teamA] = await db
    .insert(teams)
    .values({ tenantId: TENANT_A, name: "Platform Engineering" })
    .returning({ id: teams.id });
  const [teamB] = await db
    .insert(teams)
    .values({ tenantId: TENANT_B, name: "Platform Engineering" })
    .returning({ id: teams.id });
  teamAId = teamA!.id;
  teamBId = teamB!.id;
});

afterAll(async () => {
  await db.delete(teams).where(eq(teams.tenantId, TENANT_A));
  await db.delete(teams).where(eq(teams.tenantId, TENANT_B));
});

describe("teams — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's team", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.id, teamBId), eq(teams.tenantId, TENANT_A)));
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own team", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.tenantId, TENANT_A));
      expect(rows.map((r) => r.id)).toContain(teamAId);
    });
  });

  it("RLS blocks a raw cross-tenant SELECT under app_user role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx
        .select({ id: teams.id })
        .from(teams)
        .where(eq(teams.id, teamBId));
    });
    expect(rows).toHaveLength(0);
  });
});

describe("teams — cross-tenant WRITE isolation", () => {
  it("RLS blocks inserting a row tagged with a different tenant_id under app_user role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx
          .insert(teams)
          .values({ tenantId: TENANT_B, name: "Smuggled Team" });
      }),
    ).rejects.toBeTruthy();
  });
});
