/**
 * Drift guard (#635, docs/specs/gdpr-erasure-coverage.md R5): every tenant-scoped
 * base table must be either deleted by the tenant purge or explicitly exempted
 * with a reason. Adding a tenant table without wiring it into
 * apps/worker/src/tenant-purge.ts fails here, naming the table.
 */
import { describe, it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@platform/db";

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn() };
  }),
}));
vi.mock("../../src/queues.js", () => ({ connection: {} }));

const { PURGED_TENANT_TABLES, ERASURE_EXEMPT_TABLES } =
  await import("../../src/tenant-purge.js");

async function tenantBaseTables(): Promise<string[]> {
  const rows = await db.execute<{ table_name: string }>(sql`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name`);
  return rows.map((r) => r.table_name);
}

describe("erasure coverage guard — tenant tables", () => {
  it("every tenant-scoped table is purged or exempted with a reason", async () => {
    const known = new Set([
      ...PURGED_TENANT_TABLES,
      ...Object.keys(ERASURE_EXEMPT_TABLES),
    ]);
    const uncovered = (await tenantBaseTables()).filter((t) => !known.has(t));
    expect(
      uncovered,
      "add these to tenant-purge.ts (PURGED_TENANT_TABLES + a delete) or ERASURE_EXEMPT_TABLES",
    ).toEqual([]);
  });

  it("lists no table that no longer exists", async () => {
    const actual = new Set(await tenantBaseTables());
    const stale = [
      ...PURGED_TENANT_TABLES,
      ...Object.keys(ERASURE_EXEMPT_TABLES),
    ].filter((t) => !actual.has(t));
    expect(stale).toEqual([]);
  });

  it("never both purges and exempts the same table", () => {
    const both = PURGED_TENANT_TABLES.filter((t) => t in ERASURE_EXEMPT_TABLES);
    expect(both).toEqual([]);
  });
});
