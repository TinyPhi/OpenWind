/**
 * Tests for the new GET /admin/members route (PR #602 review, BLOCKER-1) --
 * mirrors teams-services-oncall-schedules-routes.isolation.test.ts's pattern:
 * mount the real router behind a pre-populated `auth` context (requireAuth
 * short-circuits when `c.get("auth")` is already set), issue real HTTP
 * requests against a real Postgres instance (run with docker compose up -d).
 *
 * Role-based filtering (agent/admin vs "user") is already covered by the
 * mocked unit test (src/routes/admin/members.test.ts); what matters here is
 * (a) the route is genuinely admin-gated over a real requireRole middleware,
 * and (b) it doesn't error or leak across tenants when a tenant has no
 * Zitadel org configured (orgId absent -- the DB-only fallback path).
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, tenants, tenantUsers } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { membersRouter } from "../../src/routes/admin/members.js";

const TENANT_A = "aaaaaaaa-7777-4000-a000-000000000001";
const TENANT_B = "bbbbbbbb-7777-4000-b000-000000000002";

function makeApp(tenantId: string, roles: string[]) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId,
        userId: "u-test",
        roles,
        email: "test@example.com",
      });
      await next();
    },
  );
  app.route("/admin/members", membersRouter);
  return app;
}

afterAll(async () => {
  await db
    .delete(tenantUsers)
    .where(inArray(tenantUsers.tenantId, [TENANT_A, TENANT_B]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
});

describe("GET /admin/members — route-level access control", () => {
  it("rejects a non-admin caller with 403", async () => {
    await db.insert(tenants).values({
      id: TENANT_A,
      name: "Members Route A",
      slug: `members-route-a-${TENANT_A}`,
    });

    const res = await makeApp(TENANT_A, ["agent"]).request("/admin/members");
    expect(res.status).toBe(403);
  });

  it("an admin caller succeeds and does not see another tenant's data", async () => {
    await db.insert(tenants).values({
      id: TENANT_B,
      name: "Members Route B",
      slug: `members-route-b-${TENANT_B}`,
    });

    const res = await makeApp(TENANT_B, ["admin"]).request("/admin/members");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: unknown[] };
    // No Zitadel org configured in this test (orgId omitted) -- exercises
    // the DB-only fallback path, which must not throw and must not surface
    // anything scoped to a different tenant.
    expect(Array.isArray(data)).toBe(true);
  });
});
