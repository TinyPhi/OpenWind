/**
 * Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md, ADR-022 Decision 1). Guards the
 * two invariants the whole platform_admin risk-containment argument rests on:
 *
 * 1. platform_admin_role has zero privileges on any business-data table -- a permission
 *    error, not an RLS-filtered empty result, because there is no GRANT at all.
 * 2. app_user's membership in platform_admin_role is non-inheriting (`WITH INHERIT FALSE`,
 *    migration 0134). A plain `GRANT platform_admin_role TO app_user` would have let every
 *    ordinary tenant-scoped request passively inherit platform_admin_role's privileges with
 *    no SET ROLE at all -- caught in security review before this shipped; this test is the
 *    regression guard against ever reverting to a plain GRANT.
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@platform/db";

// DrizzleQueryError's own `.message` is a generic "Failed query: ..." wrapper -- the real
// Postgres error text (e.g. "permission denied for table X") lives in `.cause.message`.
async function expectPermissionDenied(p: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await p;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  const cause = (thrown as { cause?: unknown }).cause;
  expect(cause).toBeInstanceOf(Error);
  expect((cause as Error).message).toMatch(/permission denied/i);
}

describe("platform_admin_role", () => {
  it("cannot SELECT from a business-data table (entity_instances) -- permission denied, not empty rows", async () => {
    await expectPermissionDenied(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(sql`SET LOCAL ROLE platform_admin_role`);
        return tx.execute(sql`SELECT 1 FROM entity_instances LIMIT 1`);
      }),
    );
  });

  it("can SELECT only the allow-listed metadata columns on tenants", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_user`);
      await tx.execute(sql`SET LOCAL ROLE platform_admin_role`);
      return tx.execute(
        sql`SELECT id, name, is_sandbox, trial_ends_at, created_by_platform_admin FROM tenants LIMIT 1`,
      );
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("cannot SELECT a non-allow-listed tenants column (config) -- permission denied", async () => {
    await expectPermissionDenied(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.execute(sql`SET LOCAL ROLE platform_admin_role`);
        return tx.execute(sql`SELECT config FROM tenants LIMIT 1`);
      }),
    );
  });

  it("every grant of app_user's membership in platform_admin_role is non-inheriting (regression guard for the security-review finding)", async () => {
    // A role can be granted the same membership more than once by different grantors
    // (e.g. once by the migration's own executing role, once by a bootstrap default) --
    // every one of those rows must carry inherit_option=false, not just "at least one".
    const rows = await db.execute<{ inherit_option: boolean }>(sql`
      SELECT m.inherit_option
      FROM pg_auth_members m
      JOIN pg_roles member ON m.member = member.oid
      JOIN pg_roles role ON m.roleid = role.oid
      WHERE member.rolname = 'app_user' AND role.rolname = 'platform_admin_role'
    `);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.inherit_option).toBe(false);
    }
  });
});
