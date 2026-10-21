/**
 * Isolation tests for PATCH /admin/tenants/:id/retention
 * (Issue #637: Configurable per-tenant retention policy updates).
 *
 * Confirms role gate, platform operator fence, multi-tenant cross-isolation,
 * shortening safety guard, null clearing back to defaults, real DB persistence
 * into tenants.config, and admin_audit_log entry.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq, desc } from "drizzle-orm";
import { db, tenants, adminAuditLog, withTenantContext } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { updateTenantRetentionHandlers } from "../../src/routes/admin/tenants.js";
import { setTenantRateLimitOverride } from "@platform/auth";
import { env } from "@platform/config";

const TENANT = "aaaaaaaa-3333-4000-a000-000000000f03";
const TENANT_B = "aaaaaaaa-3333-4000-a000-000000000f04";
const TENANT_C = "aaaaaaaa-3333-4000-a000-000000000f05";
const PLATFORM_ORG = "aaaaaaaa-0000-4000-a000-000000000060";

let originalPlatformOrgId: string | undefined;

beforeAll(async () => {
  originalPlatformOrgId = env.PLATFORM_ORG_ID;
  env.PLATFORM_ORG_ID = PLATFORM_ORG;

  await db.insert(tenants).values([
    {
      id: TENANT_C,
      name: "Retention Config Tenant C",
      slug: `retention-config-${TENANT_C}`,
      config: {
        rate_limit_per_min: 400,
        retention_days: 90,
        retention_comment_days: 365,
        retention_evidence_days: 2555,
      },
    },
    {
      id: TENANT,
      name: "Retention Config Tenant A",
      slug: `retention-config-${TENANT}`,
      config: {
        rate_limit_per_min: 500,
        retention_days: 90,
        retention_comment_days: 90,
        retention_evidence_days: 2555,
        retention_hold: false,
      },
    },
    {
      id: TENANT_B,
      name: "Retention Config Tenant B",
      slug: `retention-config-${TENANT_B}`,
      config: {
        rate_limit_per_min: 300,
        retention_days: 60,
        retention_comment_days: 60,
        retention_evidence_days: 1000,
        retention_hold: false,
      },
    },
  ]);
});

afterAll(async () => {
  try {
    await db
      .delete(adminAuditLog)
      .where(inArray(adminAuditLog.tenantId, [TENANT, TENANT_B, TENANT_C]));
    await db
      .delete(tenants)
      .where(inArray(tenants.id, [TENANT, TENANT_B, TENANT_C]));
  } finally {
    env.PLATFORM_ORG_ID = originalPlatformOrgId;
  }
});

function makeApp(roles: string[], callerTenantId: string = PLATFORM_ORG) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use(
    "*",
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: callerTenantId,
        userId: "isolation-test-user",
        roles,
        email: "test@example.com",
      });
      await next();
    },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.patch("/:id/retention", ...(updateTenantRetentionHandlers as any));
  return app;
}

// requireIntrospection() reads the Authorization header directly off the
// request regardless of the auth context already being set — an sk_-prefixed
// bearer token short-circuits it (API keys are exempt from introspection),
// avoiding the need for a live Zitadel connection in this test.
function skHeaders(extra: Record<string, string> = {}) {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer sk_isolation_test_bypass",
    ...extra,
  };
}

describe("PATCH /admin/tenants/:id/retention — token introspection", () => {
  it("rejects with 401 when Authorization header is missing", async () => {
    const res = await makeApp(["superadmin"]).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 120 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /admin/tenants/:id/retention — role gate", () => {
  it("agent is forbidden from setting retention config", async () => {
    const res = await makeApp(["agent"]).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({ retention_days: 120 }),
    });
    expect(res.status).toBe(403);
  });

  it("admin is forbidden from setting retention config", async () => {
    const res = await makeApp(["admin"]).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({ retention_days: 120 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("PATCH /admin/tenants/:id/retention — platform operator & nonexistent tenant", () => {
  it("returns 404 for a caller not in PLATFORM_ORG_ID", async () => {
    const res = await makeApp(
      ["superadmin"],
      "aaaaaaaa-8888-4000-a000-000000000088",
    ).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({ retention_days: 120 }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent tenant id", async () => {
    const res = await makeApp(["superadmin"]).request(
      "/aaaaaaaa-9999-4000-a000-000000000f99/retention",
      {
        method: "PATCH",
        headers: skHeaders(),
        body: JSON.stringify({ retention_days: 120 }),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /admin/tenants/:id/retention — multi-tenant isolation", () => {
  it("tenant A superadmin cannot change tenant B retention and tenant B DB row is untouched", async () => {
    const [beforeB] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, TENANT_B))
      .limit(1);

    const res = await makeApp(["superadmin"], TENANT).request(
      `/${TENANT_B}/retention`,
      {
        method: "PATCH",
        headers: skHeaders(),
        body: JSON.stringify({ retention_days: 120 }),
      },
    );
    expect(res.status).toBe(404);

    const [afterB] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, TENANT_B))
      .limit(1);

    expect(afterB?.config).toEqual(beforeB?.config);
  });
});

describe("PATCH /admin/tenants/:id/retention — updates, null clears, and audit trail", () => {
  it("requires confirmShorten when reducing retention window", async () => {
    const res = await makeApp(["superadmin"]).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({ retention_days: 30 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("CONFIRM_SHORTEN_REQUIRED");
  });

  it("successfully updates retention policy when confirmShorten: true is supplied", async () => {
    const res = await makeApp(["superadmin"]).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: skHeaders(),
      body: JSON.stringify({ retention_days: 30, confirmShorten: true }),
    });
    expect(res.status).toBe(200);

    // Verify row in database
    const [row] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, TENANT))
      .limit(1);

    const cfg = (row?.config as Record<string, unknown>) ?? {};
    expect(cfg["retention_days"]).toBe(30);
    // Non-retention keys must be preserved
    expect(cfg["rate_limit_per_min"]).toBe(500);

    // Verify audit log row
    const auditRows = await withTenantContext(TENANT, (tx) =>
      tx
        .select()
        .from(adminAuditLog)
        .where(eq(adminAuditLog.resourceId, TENANT))
        .orderBy(desc(adminAuditLog.id)),
    );

    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const latest = auditRows[0];
    expect(latest.action).toBe("updated");
    expect(latest.resourceType).toBe("tenant");
    expect(latest.resourceId).toBe(TENANT);
    expect(latest.beforeSnapshot).toMatchObject({ retention_days: 90 });
    expect(latest.afterSnapshot).toMatchObject({ retention_days: 30 });
    expect(latest.metadata).toEqual({
      type: "retention_policy_update",
      confirmShorten: true,
    });
  });

  it("successfully clears retention override with null and deletes key from config", async () => {
    // First, set retention_days to 180 (widening, no confirmShorten required)
    const widenRes = await makeApp(["superadmin"]).request(
      `/${TENANT}/retention`,
      {
        method: "PATCH",
        headers: skHeaders(),
        body: JSON.stringify({ retention_days: 180 }),
      },
    );
    expect(widenRes.status).toBe(200);

    // Verify DB has 180
    const [widenRow] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, TENANT))
      .limit(1);
    expect(
      (widenRow?.config as Record<string, unknown>)?.["retention_days"],
    ).toBe(180);

    // Clearing back to platform default (90) shortens window (180 -> 90), so requires confirmShorten: true
    const clearNoConfirm = await makeApp(["superadmin"]).request(
      `/${TENANT}/retention`,
      {
        method: "PATCH",
        headers: skHeaders(),
        body: JSON.stringify({ retention_days: null }),
      },
    );
    expect(clearNoConfirm.status).toBe(400);

    // Now clear with confirmShorten: true
    const clearRes = await makeApp(["superadmin"]).request(
      `/${TENANT}/retention`,
      {
        method: "PATCH",
        headers: skHeaders(),
        body: JSON.stringify({ retention_days: null, confirmShorten: true }),
      },
    );
    expect(clearRes.status).toBe(200);
    const body = (await clearRes.json()) as { data: Record<string, unknown> };
    expect(body.data.retention_days).toBe(env.RETENTION_DEFAULT_DAYS);

    // Verify DB config has removed retention_days completely while preserving rate_limit_per_min
    const [finalRow] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, TENANT))
      .limit(1);
    const finalCfg = (finalRow?.config as Record<string, unknown>) ?? {};
    expect(finalCfg).not.toHaveProperty("retention_days");
    expect(finalCfg["rate_limit_per_min"]).toBe(500);
  });
});

describe("PATCH /admin/tenants/:id/retention — concurrent updates (#637)", () => {
  it("keeps every concurrent change and the rate limit, because each update locks the tenant row", async () => {
    const patch = (body: Record<string, unknown>) =>
      makeApp(["superadmin"]).request(`/${TENANT_C}/retention`, {
        method: "PATCH",
        headers: skHeaders(),
        body: JSON.stringify({ ...body, confirmShorten: true }),
      });

    const results = await Promise.all([
      patch({ retention_days: 40 }),
      patch({ retention_comment_days: 100 }),
      patch({ retention_evidence_days: 800 }),
      patch({ retention_hold: true }),
      setTenantRateLimitOverride(db, TENANT_C, 900),
    ]);
    for (const r of results.slice(0, 4)) {
      expect((r as Response).status).toBe(200);
    }

    const [row] = await db
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, TENANT_C))
      .limit(1);
    const cfg = (row?.config as Record<string, unknown>) ?? {};
    expect(cfg["retention_days"]).toBe(40);
    expect(cfg["retention_comment_days"]).toBe(100);
    expect(cfg["retention_evidence_days"]).toBe(800);
    expect(cfg["retention_hold"]).toBe(true);
    expect(cfg["rate_limit_per_min"]).toBe(900);
  });
});

describe("PATCH /admin/tenants/:id/retention — RETENTION_REQUIRE_SHORTEN_CONFIRM (#637)", () => {
  it("lets a shortening through without confirmShorten when the requirement is off", async () => {
    const original = env.RETENTION_REQUIRE_SHORTEN_CONFIRM;
    env.RETENTION_REQUIRE_SHORTEN_CONFIRM = false;
    try {
      const res = await makeApp(["superadmin"]).request(
        `/${TENANT_B}/retention`,
        {
          method: "PATCH",
          headers: skHeaders(),
          body: JSON.stringify({ retention_days: 20 }), // current is 60
        },
      );
      expect(res.status).toBe(200);
    } finally {
      env.RETENTION_REQUIRE_SHORTEN_CONFIRM = original;
    }
  });
});
