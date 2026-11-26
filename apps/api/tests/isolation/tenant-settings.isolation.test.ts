/**
 * Tenant isolation tests for the tenant_settings table (#1158).
 *
 * docs/specs/temporal-scheduler.md -- per-tenant default timezone.
 * Requires a live Postgres instance (run with docker compose up -d).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db, withTenantContext, tenantSettings, tenants } from "@platform/db";

const TENANT_A = "aaaaaaaa-4444-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-4444-4000-b000-000000000002";

beforeAll(async () => {
  // tenant_settings.tenant_id REFERENCES tenants(id) -- real tenant rows required.
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Tenant Settings Isolation Test A",
      slug: `settings-isolation-a-${TENANT_A}`,
    },
    {
      id: TENANT_B,
      name: "Tenant Settings Isolation Test B",
      slug: `settings-isolation-b-${TENANT_B}`,
    },
  ]);
  await db.insert(tenantSettings).values([
    {
      tenantId: TENANT_A,
      defaultTimezone: "Europe/Berlin",
    },
    {
      tenantId: TENANT_B,
      defaultTimezone: "America/New_York",
    },
  ]);
});

afterAll(async () => {
  await db
    .delete(tenantSettings)
    .where(inArray(tenantSettings.tenantId, [TENANT_A, TENANT_B]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("tenant_settings — cross-tenant READ isolation", () => {
  it("Tenant A's read scoped to Tenant A does not return Tenant B's settings", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const rows = await tx
        .select({
          tenantId: tenantSettings.tenantId,
          defaultTimezone: tenantSettings.defaultTimezone,
        })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, TENANT_B));
      expect(rows).toHaveLength(0);
    });
  });

  it("Tenant A can read its own default timezone", async () => {
    await withTenantContext(TENANT_A, async (tx) => {
      const [row] = await tx
        .select({
          tenantId: tenantSettings.tenantId,
          defaultTimezone: tenantSettings.defaultTimezone,
        })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, TENANT_A));
      expect(row?.defaultTimezone).toBe("Europe/Berlin");
    });
  });

  it("RLS blocks a raw cross-tenant SELECT under app_user role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      return tx
        .select({ tenantId: tenantSettings.tenantId })
        .from(tenantSettings)
        .where(eq(tenantSettings.tenantId, TENANT_B));
    });
    expect(rows).toHaveLength(0);
  });
});

describe("tenant_settings — cross-tenant WRITE isolation", () => {
  it("RLS blocks inserting a row tagged with a different tenant_id under app_user role", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(
          sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
        );
        await tx.insert(tenantSettings).values({
          tenantId: TENANT_B,
          defaultTimezone: "Asia/Tokyo",
        });
      }),
    ).rejects.toBeTruthy();
  });

  it("RLS blocks updating a different tenant's settings under app_user role", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${TENANT_A}, true)`,
      );
      await tx
        .update(tenantSettings)
        .set({ defaultTimezone: "Asia/Tokyo" })
        .where(eq(tenantSettings.tenantId, TENANT_B));
    });

    // Verify Tenant B's setting was untouched
    const [rowB] = await db
      .select({ defaultTimezone: tenantSettings.defaultTimezone })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, TENANT_B));
    expect(rowB?.defaultTimezone).toBe("America/New_York");
  });
});
