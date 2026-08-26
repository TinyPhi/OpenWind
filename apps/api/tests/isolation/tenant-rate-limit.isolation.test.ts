/**
 * Isolation tests for PATCH /admin/tenants/:id/rate-limit
 * (ADR-012 Phase G, spec R2 -- per-tenant admin-editable rate-limit ceiling).
 *
 * Uses a real Postgres database (no mocks). Confirms the role gate and that
 * the override is actually persisted into tenants.config, then read back
 * via getTenantRateLimitOverride against the same real row.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq, and, desc } from "drizzle-orm";
import { db, tenants, adminAuditLog } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import {
  getTenantRateLimitOverride,
  _clearTenantRateLimitCacheForTests,
} from "@platform/auth";
import { updateTenantRateLimitHandlers } from "../../src/routes/admin/tenants.js";

const TENANT = "aaaaaaaa-2222-4000-a000-000000000f02";

beforeAll(async () => {
  await db.insert(tenants).values({
    id: TENANT,
    name: "Rate Limit Override Tenant",
    slug: `rate-limit-override-${TENANT}`,
  });
});

afterAll(async () => {
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, TENANT));
});

function makeApp(roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "aaaaaaaa-0000-4000-a000-000000000060",
        userId: "isolation-test-user",
        roles,
        email: "test@example.com",
      });
      await next();
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.patch("/:id/rate-limit", ...(updateTenantRateLimitHandlers as any));
  return app;
}

describe("PATCH /admin/tenants/:id/rate-limit — role gate", () => {
  it("agent is forbidden from setting a tenant rate-limit override", async () => {
    const res = await makeApp(["agent"]).request(`/${TENANT}/rate-limit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratePerMin: 1000 }),
    });
    expect(res.status).toBe(403);
  });

  it("admin is forbidden from setting a tenant rate-limit override", async () => {
    const res = await makeApp(["admin"]).request(`/${TENANT}/rate-limit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratePerMin: 1000 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /admin/tenants/:id/rate-limit — real update", () => {
  it("404s for a nonexistent tenant id", async () => {
    _clearTenantRateLimitCacheForTests();
    const res = await makeApp(["superadmin"]).request(
      "/aaaaaaaa-9999-4000-a000-000000000f99/rate-limit",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ratePerMin: 1000 }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("superadmin can set an override and it is readable via getTenantRateLimitOverride", async () => {
    _clearTenantRateLimitCacheForTests();
    const res = await makeApp(["superadmin"]).request(`/${TENANT}/rate-limit`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ratePerMin: 1200 }),
    });
    expect(res.status).toBe(200);

    const override = await getTenantRateLimitOverride(db, TENANT);
    expect(override).toBe(1200);

    // ADR-012 Phase G, final /security-review (T12) finding -- this route
    // previously had no audit trail, unlike every sibling tenant-lifecycle
    // mutation.
    const [auditRow] = await db
      .select()
      .from(adminAuditLog)
      .where(
        and(
          eq(adminAuditLog.tenantId, TENANT),
          eq(adminAuditLog.action, "updated"),
        ),
      )
      .orderBy(desc(adminAuditLog.createdAt))
      .limit(1);
    expect(auditRow?.actorId).toBe("isolation-test-user");
    expect(
      (auditRow?.afterSnapshot as { ratePerMin: number } | null)?.ratePerMin,
    ).toBe(1200);
  });

  it("superadmin can clear the override by passing null", async () => {
    _clearTenantRateLimitCacheForTests();
    const setRes = await makeApp(["superadmin"]).request(
      `/${TENANT}/rate-limit`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ratePerMin: 500 }),
      },
    );
    expect(setRes.status).toBe(200);

    const clearRes = await makeApp(["superadmin"]).request(
      `/${TENANT}/rate-limit`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ratePerMin: null }),
      },
    );
    expect(clearRes.status).toBe(200);

    _clearTenantRateLimitCacheForTests();
    const override = await getTenantRateLimitOverride(db, TENANT);
    expect(override).toBeNull();
  });
});
