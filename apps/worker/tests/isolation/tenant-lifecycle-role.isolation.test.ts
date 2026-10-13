/**
 * Migration 0142: tenant_lifecycle_role. app_user deliberately cannot insert tenants or change
 * their status (#404-#408), so the lifecycle writes (provisioning, suspend/restore/delete,
 * sandbox rollback, purge) switch to this role instead. These tests pin both halves: the
 * #404-#408 hardening on app_user still holds, and the new role can do exactly the lifecycle
 * writes -- no other column. Real Postgres; both helpers SET LOCAL ROLE, so grants are
 * genuinely enforced even though this suite connects as a superuser.
 */
import { describe, it, expect, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, tenants, withTenantLifecycleContext } from "@platform/db";

const TENANT_ID = "eeeeeeee-0192-4000-e000-000000000192";

async function rejection(work: () => Promise<unknown>): Promise<string> {
  const err: unknown = await work().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "expected the write to be refused").toBeInstanceOf(Error);
  // Drizzle wraps the Postgres error; the permission message is on `cause`.
  return String((err as Error).cause ?? err);
}

afterAll(async () => {
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("tenant_lifecycle_role (migration 0142)", () => {
  it("app_user still cannot insert a tenant (#405 hardening intact)", async () => {
    const msg = await rejection(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx.insert(tenants).values({
          id: TENANT_ID,
          name: "lifecycle-role probe",
          slug: `lifecycle-role-probe-${Date.now()}`,
        });
      }),
    );
    expect(msg).toMatch(/permission denied/);
  });

  // This suite connects as a superuser, and a superuser may SET ROLE to anything -- so on its
  // own the rest of this file wouldn't prove the production path. Becoming app_user first
  // makes Postgres check app_user's real membership (WITH INHERIT FALSE, SET allowed).
  it("a real app_user session can switch into tenant_lifecycle_role", async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL SESSION AUTHORIZATION app_user`);
      await tx.execute(sql`SET LOCAL ROLE tenant_lifecycle_role`);
      return tx.execute<{ session_user: string; current_user: string }>(
        sql`SELECT session_user, current_user`,
      );
    });

    expect(rows[0]).toEqual({
      session_user: "app_user",
      current_user: "tenant_lifecycle_role",
    });
  });

  it("creates, changes lifecycle status of, and deletes a tenant through the role", async () => {
    const now = new Date();
    await withTenantLifecycleContext((tx) =>
      tx.insert(tenants).values({
        id: TENANT_ID,
        name: "lifecycle-role probe",
        slug: `lifecycle-role-probe-${Date.now()}`,
        status: "active",
      }),
    );

    await withTenantLifecycleContext((tx) =>
      tx
        .update(tenants)
        .set({
          status: "deleted",
          suspendedAt: now,
          deletionScheduledAt: now,
          updatedAt: now,
        })
        .where(eq(tenants.id, TENANT_ID)),
    );
    const [row] = await db
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID));
    expect(row?.status).toBe("deleted");

    await withTenantLifecycleContext((tx) =>
      tx.delete(tenants).where(eq(tenants.id, TENANT_ID)),
    );
    const remaining = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID));
    expect(remaining).toHaveLength(0);
  });

  it.each([
    ["name", { name: "renamed" }],
    ["plan", { plan: "enterprise" }],
    ["config", { config: { injected: true } }],
    ["isSandbox", { isSandbox: true }],
  ] as const)(
    "cannot update %s -- only lifecycle columns are granted",
    async (_column, patch) => {
      await db
        .insert(tenants)
        .values({
          id: TENANT_ID,
          name: "lifecycle-role probe",
          slug: `lifecycle-role-probe-${Date.now()}`,
        })
        .onConflictDoNothing();

      const msg = await rejection(() =>
        withTenantLifecycleContext((tx) =>
          tx.update(tenants).set(patch).where(eq(tenants.id, TENANT_ID)),
        ),
      );
      expect(msg).toMatch(/permission denied/);
    },
  );

  it("app_user still cannot change a tenant's status (#408 hardening intact)", async () => {
    await db
      .insert(tenants)
      .values({
        id: TENANT_ID,
        name: "lifecycle-role probe",
        slug: `lifecycle-role-probe-${Date.now()}`,
      })
      .onConflictDoNothing();

    const msg = await rejection(() =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await tx
          .update(tenants)
          .set({ status: "suspended" })
          .where(eq(tenants.id, TENANT_ID));
      }),
    );
    expect(msg).toMatch(/permission denied/);
  });
});
