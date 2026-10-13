/**
 * The sandbox lifecycle workers write admin_audit_log outcome entries. That table is
 * RLS-protected and the worker connects as app_user, so a write on the plain connection is
 * rejected every time -- a provisioning run that built everything then failed on its final
 * audit write and rolled the whole sandbox back. Every other isolation test connects as a
 * superuser, which bypasses RLS, so nothing caught it. These tests drop to app_user.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, tenants, adminAuditLog, withTenantContext } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";

const TENANT_ID = "eeeeeeee-0190-4000-e000-000000000190";

beforeAll(async () => {
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: "sandbox audit tenant-context regression tenant",
      slug: `sandbox-audit-ctx-${Date.now()}`,
      isSandbox: false,
      status: "active",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_ID));
});

describe("sandbox worker audit writes under app_user RLS", () => {
  it("rejects an admin_audit_log write as app_user with no tenant context (the old worker path)", async () => {
    const err: unknown = await db
      .transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE app_user`);
        await writeAuditEntry(tx, {
          tenantId: TENANT_ID,
          actorId: "admin-1",
          actorType: "user",
          resourceType: "tenant",
          resourceId: TENANT_ID,
          action: "sandbox.delete_failed",
        });
      })
      .catch((e: unknown) => e);

    // Drizzle wraps the Postgres error; the RLS rejection is on `cause`.
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).cause)).toMatch(/row-level security/);
  });

  // withTenantContext itself does SET LOCAL ROLE app_user, so RLS is genuinely enforced here
  // even though this suite's connection is a superuser. The workers' unit tests assert they
  // write through withTenantContext; together these cover the fix. (Running a worker job
  // directly here would not: its plain `db` writes bypass RLS on a superuser connection.)
  it("accepts the same write through withTenantContext (the fixed worker path)", async () => {
    await withTenantContext(TENANT_ID, (tx) =>
      writeAuditEntry(tx, {
        tenantId: TENANT_ID,
        actorId: "admin-1",
        actorType: "user",
        resourceType: "tenant",
        resourceId: TENANT_ID,
        action: "sandbox.delete_failed",
      }),
    );

    const rows = await db
      .select({ action: adminAuditLog.action })
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, TENANT_ID),
          eq(adminAuditLog.action, "sandbox.delete_failed"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("rejects a row filed under a different tenant than the context's", async () => {
    const otherTenant = "eeeeeeee-0190-4000-e000-000000000191";
    const err: unknown = await withTenantContext(otherTenant, (tx) =>
      writeAuditEntry(tx, {
        tenantId: TENANT_ID,
        actorId: "admin-1",
        actorType: "user",
        resourceType: "tenant",
        resourceId: TENANT_ID,
        action: "sandbox.delete_failed",
      }),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).cause)).toMatch(/row-level security/);
  });
});
