/**
 * Tenant isolation tests for the tenant_usage_daily table (issue #505).
 *
 * Two layers, both tested here:
 *  1. Explicit WHERE tenant_id = $tenantId (layer 1 — primary guard).
 *  2. Postgres RLS policy `tenant_usage_daily_tenant_isolation` (layer 2 — enforced
 *     via SET LOCAL ROLE app_user inside withTenantContext, per #121/#122).
 *
 * Requires a live Postgres instance.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import { db, withTenantContext, tenants, tenantUsageDaily } from "@platform/db";

const TENANT_A = "aaaaaaaa-0085-4000-a000-000000000085";
const TENANT_B = "bbbbbbbb-0085-4000-b000-000000000085";

let insertedA = false;
let insertedB = false;

beforeAll(async () => {
  await db.insert(tenants).values([
    {
      id: TENANT_A,
      name: "Isolation Tenant A (usage)",
      slug: `isolation-usage-a-${Date.now()}`,
    },
    {
      id: TENANT_B,
      name: "Isolation Tenant B (usage)",
      slug: `isolation-usage-b-${Date.now()}`,
    },
  ]);

  // Insert via withTenantContext (SET LOCAL ROLE app_user) — proves the GRANT
  // in migration 0085 is present.
  await withTenantContext(TENANT_A, (tx) =>
    tx.insert(tenantUsageDaily).values({
      tenantId: TENANT_A,
      usageDate: "2026-08-28",
      metric: "api_calls",
      value: 1200,
    }),
  );
  insertedA = true;

  await withTenantContext(TENANT_B, (tx) =>
    tx.insert(tenantUsageDaily).values({
      tenantId: TENANT_B,
      usageDate: "2026-08-28",
      metric: "api_calls",
      value: 2500,
    }),
  );
  insertedB = true;
});

afterAll(async () => {
  await db
    .delete(tenantUsageDaily)
    .where(eq(tenantUsageDaily.tenantId, TENANT_A));
  await db
    .delete(tenantUsageDaily)
    .where(eq(tenantUsageDaily.tenantId, TENANT_B));
  await db.delete(tenants).where(eq(tenants.id, TENANT_A));
  await db.delete(tenants).where(eq(tenants.id, TENANT_B));
});

describe("tenant_usage_daily — app_user GRANT (migration 0085)", () => {
  it("INSERT via withTenantContext succeeds against real Postgres+RLS", () => {
    expect(insertedA).toBe(true);
    expect(insertedB).toBe(true);
  });

  it("UPDATE via withTenantContext succeeds (matches GRANT SELECT, INSERT, UPDATE)", async () => {
    await withTenantContext(TENANT_A, (tx) =>
      tx
        .update(tenantUsageDaily)
        .set({ value: 1300 })
        .where(
          and(
            eq(tenantUsageDaily.tenantId, TENANT_A),
            eq(tenantUsageDaily.usageDate, "2026-08-28"),
            eq(tenantUsageDaily.metric, "api_calls"),
          ),
        ),
    );

    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ value: tenantUsageDaily.value })
        .from(tenantUsageDaily)
        .where(
          and(
            eq(tenantUsageDaily.tenantId, TENANT_A),
            eq(tenantUsageDaily.usageDate, "2026-08-28"),
            eq(tenantUsageDaily.metric, "api_calls"),
          ),
        ),
    );
    expect(rows[0]!.value).toBe(1300);
  });
});

describe("tenant_usage_daily — cross-tenant READ isolation (layer 1: explicit filter)", () => {
  it("query scoped to Tenant A never returns Tenant B's usage row", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx
        .select({ value: tenantUsageDaily.value })
        .from(tenantUsageDaily)
        .where(
          and(
            eq(tenantUsageDaily.tenantId, TENANT_A),
            eq(tenantUsageDaily.usageDate, "2026-08-28"),
            eq(tenantUsageDaily.metric, "api_calls"),
          ),
        ),
    );
    // Should only get TENANT_A's row
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(1300);
  });
});

describe("tenant_usage_daily — RLS enforcement independent of explicit filter (layer 2)", () => {
  it("a query with the app.tenant_id GUC set to Tenant A returns 0 rows for Tenant B's row, even with no WHERE tenant_id clause", async () => {
    const rows = await withTenantContext(TENANT_A, (tx) =>
      tx.execute<{ value: number }>(
        sql`SELECT value FROM tenant_usage_daily WHERE tenant_id = ${TENANT_B}::uuid`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it("a query with the app.tenant_id GUC set to Tenant B returns 0 rows for Tenant A's row, even with no WHERE tenant_id clause", async () => {
    const rows = await withTenantContext(TENANT_B, (tx) =>
      tx.execute<{ value: number }>(
        sql`SELECT value FROM tenant_usage_daily WHERE tenant_id = ${TENANT_A}::uuid`,
      ),
    );
    expect(rows).toHaveLength(0);
  });
});
