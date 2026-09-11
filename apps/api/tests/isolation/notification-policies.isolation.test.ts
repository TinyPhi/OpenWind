/**
 * Tenant isolation tests for the notification_policies table.
 *
 * docs/specs/oncall-routing.md T21, R14, R19 -- 3E on-call routing, Phase 1.
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  db,
  withTenantContext,
  notificationPolicies,
  tenants,
} from "@platform/db";

const TENANT_A = "aaaaaaaa-8888-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-8888-4000-b000-000000000002";
const USER_A = "aaaaaaaa-8888-4000-a000-000000000900";
const USER_B = "bbbbbbbb-8888-4000-b000-000000000900";

let policyAId: string;
let policyBId: string;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Notification Policies Isolation Test A",
      slug: `notif-policies-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Notification Policies Isolation Test B",
      slug: `notif-policies-isolation-b-${TENANT_B}`,
    },
  ]);
  const [policyA] = await db
    .insert(notificationPolicies)
    .values({
      tenantId: TENANT_A,
      severity: "high",
      channels: ["email"],
      createdBy: USER_A,
    })
    .returning({ id: notificationPolicies.id });
  const [policyB] = await db
    .insert(notificationPolicies)
    .values({
      tenantId: TENANT_B,
      severity: "high",
      channels: ["email"],
      createdBy: USER_B,
    })
    .returning({ id: notificationPolicies.id });
  policyAId = policyA!.id;
  policyBId = policyB!.id;
});

afterAll(async () => {
  await db
    .delete(notificationPolicies)
    .where(eq(notificationPolicies.tenantId, TENANT_A));
  await db
    .delete(notificationPolicies)
    .where(eq(notificationPolicies.tenantId, TENANT_B));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("notification_policies — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's policy", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: notificationPolicies.id })
        .from(notificationPolicies)
        .where(
          and(
            eq(notificationPolicies.id, policyBId),
            eq(notificationPolicies.tenantId, TENANT_A),
          ),
        );
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own policy", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({ id: notificationPolicies.id })
        .from(notificationPolicies)
        .where(eq(notificationPolicies.tenantId, TENANT_A));
      expect(rows.map((r) => r.id)).toContain(policyAId);
    });
  });

  it("RLS blocks a raw cross-tenant SELECT under app_user role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx
        .select({ id: notificationPolicies.id })
        .from(notificationPolicies)
        .where(eq(notificationPolicies.id, policyBId));
    });
    expect(rows).toHaveLength(0);
  });
});

describe("notification_policies — cross-tenant WRITE isolation", () => {
  it("RLS blocks inserting a row tagged with a different tenant_id under app_user role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx.insert(notificationPolicies).values({
          tenantId: TENANT_B,
          severity: "low",
          channels: ["email"],
          createdBy: USER_A,
        });
      }),
    ).rejects.toBeTruthy();
  });

  // Documents a known architectural risk boundary (PR #586 review, B3):
  // team_id has NO foreign key to teams(id) (migration 0099's comment) --
  // cross-tenant ownership is validated at the app layer only (R1d/T44).
  // RLS on this table only checks tenant_id, so a policy tagged with the
  // caller's own tenant_id but referencing another tenant's team_id passes
  // RLS. Phase 2's route layer MUST call validateCrossTenantRefs against
  // `teams` before insert/update -- see tracked follow-up issue #592.
  it("RLS alone does NOT catch a cross-tenant team_id smuggled under the correct tenant_id -- app-layer validation is the only guard", async () => {
    const foreignTeamId = "dddddddd-8888-4000-b000-000000000099";
    await withTenantContext(TENANT_A, async (tx) => {
      const [row] = await tx
        .insert(notificationPolicies)
        .values({
          tenantId: TENANT_A,
          teamId: foreignTeamId, // not a real team of any tenant
          severity: "medium",
          channels: ["email"],
          createdBy: USER_A,
        })
        .returning({
          id: notificationPolicies.id,
          teamId: notificationPolicies.teamId,
        });
      expect(row?.teamId).toBe(foreignTeamId);
    });
  });
});

describe("notification_policies — specificity uniqueness (R14)", () => {
  it("rejects a second global policy at the same severity for the same tenant", async () => {
    await expect(
      db.insert(notificationPolicies).values({
        tenantId: TENANT_A,
        severity: "high",
        channels: ["sms"],
        createdBy: USER_A,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } }); // unique_violation
  });

  it("allows a team-scoped policy at the same severity (different specificity level)", async () => {
    const [row] = await db
      .insert(notificationPolicies)
      .values({
        tenantId: TENANT_A,
        teamId: "cccccccc-8888-4000-a000-000000000001",
        severity: "high",
        channels: ["sms"],
        createdBy: USER_A,
      })
      .returning({ id: notificationPolicies.id });
    expect(row?.id).toBeTruthy();
  });
});
