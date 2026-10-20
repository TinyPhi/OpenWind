/**
 * Isolation tests for PATCH /admin/tenants/:id/retention
 * (Issue #637: Configurable per-tenant retention policy updates).
 *
 * Confirms role gate, platform operator fence, shortening safety guard,
 * real DB persistence into tenants.config, and admin_audit_log entry.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { inArray, eq } from "drizzle-orm";
import { db, tenants, adminAuditLog } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import { updateTenantRetentionHandlers } from "../../src/routes/admin/tenants.js";
import { env } from "@platform/config";

const TENANT = "aaaaaaaa-3333-4000-a000-000000000f03";
const PLATFORM_ORG = "aaaaaaaa-0000-4000-a000-000000000060";

let originalPlatformOrgId: string | undefined;

beforeAll(async () => {
  originalPlatformOrgId = env.PLATFORM_ORG_ID;
  env.PLATFORM_ORG_ID = PLATFORM_ORG;
  await db.insert(tenants).values({
    id: TENANT,
    name: "Retention Config Tenant",
    slug: `retention-config-${TENANT}`,
    config: {
      rate_limit_per_min: 500,
      retention_days: 90,
      retention_comment_days: 90,
      retention_evidence_days: 2555,
      retention_hold: false,
    },
  });
});

afterAll(async () => {
  env.PLATFORM_ORG_ID = originalPlatformOrgId;
  await db.delete(tenants).where(inArray(tenants.id, [TENANT]));
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

describe("PATCH /admin/tenants/:id/retention — role gate", () => {
  it("agent is forbidden from setting retention config", async () => {
    const res = await makeApp(["agent"]).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 120 }),
    });
    expect(res.status).toBe(403);
  });

  it("admin is forbidden from setting retention config", async () => {
    const res = await makeApp(["admin"]).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 120 }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a nonexistent tenant id", async () => {
    const res = await makeApp(["superadmin"]).request(
      "/aaaaaaaa-9999-4000-a000-000000000f99/retention",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: 120 }),
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /admin/tenants/:id/retention — updates and audit trail", () => {
  it("requires confirmShorten when reducing retention window", async () => {
    const res = await makeApp(["superadmin"]).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 30 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("CONFIRM_SHORTEN_REQUIRED");
  });

  it("successfully updates retention policy when confirmShorten: true is supplied", async () => {
    const res = await makeApp(["superadmin"]).request(`/${TENANT}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
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
    const auditRows = await db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.resourceId, TENANT));

    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    const latest = auditRows[auditRows.length - 1];
    expect(latest.action).toBe("updated");
    expect(latest.resourceType).toBe("tenant");
  });
});
