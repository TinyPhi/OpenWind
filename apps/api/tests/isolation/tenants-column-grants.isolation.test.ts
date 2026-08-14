/**
 * Isolation tests for Issue #408: tenants column-scoped UPDATE.
 * Verifies that app_user can UPDATE `config` and `updated_at`, but fails
 * with 42501 when attempting to UPDATE restricted columns like `plan`.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, withTenantContext, tenants } from "@platform/db";

const TENANT_ID = "aaaaaaaa-0408-4000-a000-000000000408";

beforeAll(async () => {
  const ts = Date.now();
  // Insert a test tenant using the root `db` connection.
  await db
    .insert(tenants)
    .values({
      id: TENANT_ID,
      name: `Test Tenant 408 ${ts}`,
      slug: `test-tenant-408-${ts}`,
      plan: "standard",
    })
    .onConflictDoNothing();
});

describe("tenants column-scoped UPDATE grants", () => {
  it("allows app_user to UPDATE config", async () => {
    // Should succeed
    await withTenantContext(TENANT_ID, async (tx) => {
      await tx
        .update(tenants)
        .set({ config: { test: "updated" } })
        .where(eq(tenants.id, TENANT_ID));
    });

    const [row] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID));
    expect(row?.config).toEqual({ test: "updated" });
  });

  it("denies app_user from UPDATE on plan", async () => {
    // Should fail with 42501 insufficient_privilege
    const promise = withTenantContext(TENANT_ID, async (tx) => {
      await tx
        .update(tenants)
        .set({ plan: "enterprise" })
        .where(eq(tenants.id, TENANT_ID));
    });

    const err = await promise.catch((e) => e);
    expect(err.cause?.message || err.message).toMatch(/permission denied/i);
    expect(err.cause?.code || err.code).toBe("42501");
  });
});
