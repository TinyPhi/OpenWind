/**
 * Isolation tests for modules (Issue #404) and tenants (Issue #405, #408) tables.
 *
 * modules and tenants are platform-wide tables with specific privilege gates.
 * app_user should not have INSERT, UPDATE, or DELETE on modules, and should not
 * have INSERT or DELETE on tenants. UPDATE on tenants is column-scoped and restricted
 * to config and updated_at (Issue #408).
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect } from "vitest";
import { sql, eq } from "drizzle-orm";
import { db, modules, tenants } from "@platform/db";

describe("modules — write restriction (Issue #404)", () => {
  it("app_user INSERT fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.insert(modules).values({
          slug: "should_not_insert_module",
          name: "Should Not Insert",
          version: "1.0.0",
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("app_user UPDATE fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx
          .update(modules)
          .set({ name: "Hijacked Module" })
          .where(eq(modules.slug, "helpdesk"));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("app_user DELETE fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.delete(modules).where(eq(modules.slug, "helpdesk"));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

describe("tenants — write restriction (Issue #405)", () => {
  it("app_user INSERT fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.insert(tenants).values({
          name: "Should Not Insert Tenant",
          slug: "should-not-insert-tenant",
        });
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("app_user DELETE fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx
          .delete(tenants)
          .where(eq(tenants.id, "aaaaaaaa-0000-4000-a000-000000000060"));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("app_user UPDATE on restricted column (plan) fails with permission denied", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx
          .update(tenants)
          .set({ plan: "premium" })
          .where(eq(tenants.id, "aaaaaaaa-0000-4000-a000-000000000060"));
      }),
    ).rejects.toMatchObject({ cause: { code: "42501" } });
  });

  it("app_user UPDATE on allowed columns (config, updatedAt) succeeds", async () => {
    let succeeded = false;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx
          .update(tenants)
          .set({ config: { test: "value" }, updatedAt: new Date() })
          .where(eq(tenants.id, "aaaaaaaa-0000-4000-a000-000000000060"));
        succeeded = true;
        throw new Error("rollback");
      });
    } catch (e) {
      if (e instanceof Error && e.message !== "rollback") {
        throw e;
      }
    }
    expect(succeeded).toBe(true);
  });
});
