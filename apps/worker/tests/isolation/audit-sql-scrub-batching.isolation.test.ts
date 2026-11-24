/**
 * #1190 G4 -- the purge removes audit SQL text in batches of 1000, not one UPDATE over every
 * SQL-bearing row of the tenant. Real Postgres and the real tenant_purge_role (through
 * withTenantPurgeContext), so this also proves the role can read the columns the batch's
 * subselect needs. 2,500 rows is more than two batches.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  tenants,
  adminAuditLog,
  withTenantPurgeContext,
} from "@platform/db";
import { anonymizeAuditLogForTenant } from "@platform/audit";

const TENANT = "ffffffff-1190-4000-a000-000000000001";
const BYSTANDER = "ffffffff-1190-4000-b000-000000000002";
const RESOURCE = "ffffffff-1190-4000-a000-000000000009";
const SQL_ROWS = 2500;
const BYSTANDER_ROWS = 1200;

async function seed(tenantId: string, count: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO admin_audit_log
      (tenant_id, actor_id, actor_type, resource_type, resource_id, action, metadata)
    SELECT ${tenantId}::uuid, 'system', 'system', 'reporting', ${RESOURCE}::uuid,
           'reporting.query_executed',
           jsonb_build_object('sql', 'SELECT ' || g, 'sql_hash', 'hash-' || g)
    FROM generate_series(1, ${count}::int) AS g
  `);
}

async function rowsWithSql(tenantId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adminAuditLog)
    .where(
      and(
        eq(adminAuditLog.tenantId, tenantId),
        sql`${adminAuditLog.metadata} ? 'sql'`,
      ),
    );
  return rows[0]?.n ?? 0;
}

async function rowCount(tenantId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adminAuditLog)
    .where(eq(adminAuditLog.tenantId, tenantId));
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  for (const id of [TENANT, BYSTANDER]) {
    await db
      .insert(tenants)
      .values({
        id,
        name: `#1190 ${id}`,
        slug: `sql-scrub-${id}`,
        status: "active",
      })
      .onConflictDoNothing();
  }
  await seed(TENANT, SQL_ROWS);
  await seed(BYSTANDER, BYSTANDER_ROWS);
});

afterAll(async () => {
  for (const t of [TENANT, BYSTANDER]) {
    await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
});

describe("tenant purge strips audit SQL text in batches (#1190)", () => {
  it("starts with SQL text on every seeded row", async () => {
    expect(await rowsWithSql(TENANT)).toBe(SQL_ROWS);
    expect(await rowsWithSql(BYSTANDER)).toBe(BYSTANDER_ROWS);
  });

  it("strips the SQL text from every row of the purged tenant, across several batches", async () => {
    await withTenantPurgeContext(TENANT, (tx) =>
      anonymizeAuditLogForTenant(tx, TENANT),
    );

    expect(await rowsWithSql(TENANT)).toBe(0);
    expect(await rowCount(TENANT)).toBe(SQL_ROWS);
  });

  it("keeps sql_hash and the rest of the metadata", async () => {
    const [kept] = await db
      .select({ metadata: adminAuditLog.metadata })
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, TENANT),
          sql`${adminAuditLog.metadata}->>'sql_hash' = 'hash-1'`,
        ),
      );
    expect(kept?.metadata).toEqual({ sql_hash: "hash-1" });
  });

  it("leaves another tenant's SQL text alone", async () => {
    expect(await rowsWithSql(BYSTANDER)).toBe(BYSTANDER_ROWS);
  });

  it("is a no-op the second time", async () => {
    await withTenantPurgeContext(TENANT, (tx) =>
      anonymizeAuditLogForTenant(tx, TENANT),
    );

    expect(await rowsWithSql(TENANT)).toBe(0);
    expect(await rowCount(TENANT)).toBe(SQL_ROWS);
  });
});
