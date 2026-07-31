/**
 * Isolation tests for GET/PATCH /admin/platform-settings (0044_platform_settings.sql).
 *
 * platform_settings is deliberately NOT tenant-scoped -- a single global
 * row (id=1) with no tenant_id and no RLS policy, same pattern as
 * modules.is_visible (see the migration's own comment). There is no
 * cross-tenant boundary to prove here; the boundary that matters is the
 * role gate -- this is a platform-operator control (the outbound
 * notifications kill switch), so it must be superadmin-only end to end
 * against real Postgres, not just unit-tested with a mocked db.
 *
 * Uses a real Postgres database (no mocks).
 */

import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { db, platformSettings } from "@platform/db";
import type { AuthContext } from "@platform/auth";
import {
  getPlatformSettingsHandler,
  updatePlatformSettingsHandler,
} from "../../src/routes/admin/platform-settings.js";

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
  app.get("/", ...(getPlatformSettingsHandler as any));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.patch("/", ...(updatePlatformSettingsHandler as any));
  return app;
}

afterEach(async () => {
  // Restore the default so this suite never leaves the singleton row flipped
  // for any other test/isolation suite that runs in the same CI database.
  await db
    .update(platformSettings)
    .set({ outboundNotificationsEnabled: true, updatedBy: null })
    .where(eq(platformSettings.id, 1));
});

describe("GET /admin/platform-settings — role gate", () => {
  it("superadmin can read the global settings row", async () => {
    const res = await makeApp(["superadmin"]).request("/");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { outboundNotificationsEnabled: boolean };
    };
    expect(typeof json.data.outboundNotificationsEnabled).toBe("boolean");
  });

  it("admin is forbidden from reading the global settings row (#231)", async () => {
    const res = await makeApp(["admin"]).request("/");
    expect(res.status).toBe(403);
  });

  it("agent is forbidden from reading the global settings row", async () => {
    const res = await makeApp(["agent"]).request("/");
    expect(res.status).toBe(403);
  });

  it("customer (user role) is forbidden from reading the global settings row", async () => {
    const res = await makeApp(["user"]).request("/");
    expect(res.status).toBe(403);
  });
});

describe("PATCH /admin/platform-settings — role gate and real update", () => {
  it("agent is forbidden from updating the kill switch", async () => {
    const res = await makeApp(["agent"]).request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outboundNotificationsEnabled: false }),
    });
    expect(res.status).toBe(403);

    // Confirm the forbidden request had no side effect on the real row.
    const [row] = await db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.id, 1));
    expect(row?.outboundNotificationsEnabled).toBe(true);
  });

  it("admin is forbidden from flipping the kill switch (#231)", async () => {
    const res = await makeApp(["admin"]).request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outboundNotificationsEnabled: false }),
    });
    expect(res.status).toBe(403);
  });

  it("superadmin can flip the kill switch off and the change persists", async () => {
    const res = await makeApp(["superadmin"]).request("/", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outboundNotificationsEnabled: false }),
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(platformSettings)
      .where(eq(platformSettings.id, 1));
    expect(row?.outboundNotificationsEnabled).toBe(false);
    expect(row?.updatedBy).toBe("isolation-test-user");
  });
});
