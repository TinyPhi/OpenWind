import { describe, it, expect } from "vitest";
import { lintPluginMigration } from "./plugin-migration-lint.js";

describe("lintPluginMigration", () => {
  it("accepts a table with tenant_id, RLS, and a policy that references tenant_id", () => {
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

  // Review finding (PR #397, PrabhuVijit): the lint used to check only that a
  // CREATE POLICY statement existed, not what it actually said — a permissive
  // "allow everyone" policy passed identically to a real tenant-isolation one.
  it("rejects a table whose policy exists but never references tenant_id (e.g. USING (true))", () => {
    const sql = `
      CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "tenant_id" uuid NOT NULL);
      ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "widgets_allow_all" ON "widgets" FOR ALL USING (true);
    `;
    const result = lintPluginMigration(sql);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      'table "widgets": CREATE POLICY exists but its body never references tenant_id ' +
        '(e.g. "USING (true)" grants every row to every caller)',
    ]);
  });

  it("accepts a policy that references tenant_id only in its WITH CHECK clause", () => {
    const sql = `
      CREATE TABLE "widgets" ("id" uuid PRIMARY KEY, "tenant_id" uuid NOT NULL);
      ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "widgets_tenant_isolation" ON "widgets"
        FOR ALL
        USING (true)
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
    `;
    // Documents current, deliberately simple behavior: the check looks for
    // tenant_id anywhere in the policy statement, not specifically inside
    // USING — a real policy should reference it in USING too, but this lint
    // is a lightweight catch for the honest-mistake case (see file header),
    // not a full SQL parser distinguishing USING from WITH CHECK.
    const result = lintPluginMigration(sql);
    expect(result.ok).toBe(true);
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
      CREATE POLICY "good_tenant_isolation" ON "good"
        FOR ALL USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

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
