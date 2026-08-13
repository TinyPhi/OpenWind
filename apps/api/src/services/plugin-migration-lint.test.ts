import { describe, it, expect } from "vitest";
import { lintPluginMigration } from "./plugin-migration-lint.js";

describe("lintPluginMigration", () => {
  it("accepts a table with tenant_id, RLS, and a policy", () => {
    const sql = `
      CREATE TABLE "widgets" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" uuid NOT NULL,
        "name" text NOT NULL
      );
      ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "widgets_tenant_isolation" ON "widgets"
        FOR ALL
        USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
    `;
    const result = lintPluginMigration(sql);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects a table with no tenant_id column and no opt-out", () => {
    const sql = `CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "name" text NOT NULL);`;
    const result = lintPluginMigration(sql);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain(
      'no "tenant_id uuid NOT NULL" column',
    );
  });

  it("rejects a table with tenant_id but no RLS enabled", () => {
    const sql = `CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "tenant_id" uuid NOT NULL);`;
    const result = lintPluginMigration(sql);
    expect(result.ok).toBe(false);
    expect(result.violations).toContain(
      'table "widgets": has tenant_id but no ENABLE ROW LEVEL SECURITY statement',
    );
    expect(result.violations).toContain(
      'table "widgets": has tenant_id but no CREATE POLICY statement',
    );
  });

  it("rejects a table with tenant_id and RLS enabled but no policy", () => {
    const sql = `
      CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "tenant_id" uuid NOT NULL);
      ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
    `;
    const result = lintPluginMigration(sql);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'table "widgets": has tenant_id but no CREATE POLICY statement',
    ]);
  });

  it("accepts a non-tenant-scoped table with the explicit opt-out comment", () => {
    const sql = `
      -- plugin-lint: not-tenant-scoped (static currency reference data, no tenant data)
      CREATE TABLE "currency_codes" ("code" text PRIMARY KEY, "name" text NOT NULL);
    `;
    const result = lintPluginMigration(sql);
    expect(result.ok).toBe(true);
  });

  it("does not let one table's opt-out comment cover a different table", () => {
    const sql = `
      -- plugin-lint: not-tenant-scoped (reference data)
      CREATE TABLE "currency_codes" ("code" text PRIMARY KEY);
      CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "name" text NOT NULL);
    `;
    const result = lintPluginMigration(sql);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('table "widgets"');
  });

  it("checks every table independently across multiple CREATE TABLE statements", () => {
    const sql = `
      CREATE TABLE "good" (
        "id" uuid PRIMARY KEY, "tenant_id" uuid NOT NULL
      );
      ALTER TABLE "good" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "good_tenant_isolation" ON "good" FOR ALL USING (true);

      CREATE TABLE "bad" ("id" uuid PRIMARY KEY);
    `;
    const result = lintPluginMigration(sql);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('table "bad"');
  });

  it("passes on migration SQL with no CREATE TABLE statements at all", () => {
    const result = lintPluginMigration(
      "ALTER TABLE existing_table ADD COLUMN foo text;",
    );
    expect(result.ok).toBe(true);
  });
});
