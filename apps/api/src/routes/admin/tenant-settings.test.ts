import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

let mockAuth: AuthContext;
let storedSetting: { defaultTimezone: string | null } | null = null;
const mockAudit = vi.fn();

vi.mock("@platform/auth", () => ({
  requireAuth: () => async (c: Context, next: Next) => {
    c.set("auth", mockAuth);
    await next();
  },
  requireRole:
    (...allowedRoles: string[]) =>
    async (c: Context, next: Next) => {
      const auth = c.get("auth") as AuthContext;
      const hasRole = auth.roles.some((r) => allowedRoles.includes(r));
      if (!hasRole) {
        return c.json({ error: "FORBIDDEN", message: "Forbidden" }, 403);
      }
      await next();
    },
}));

vi.mock("@platform/db", () => ({
  tenantSettings: {
    tenantId: "tenant_id",
    defaultTimezone: "default_timezone",
  },
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => tx,
      from: () => tx,
      where: () => tx,
      for: () => tx,
      limit: () => Promise.resolve(storedSetting ? [storedSetting] : []),
      insert: () => tx,
      values: (val: { defaultTimezone: string | null }) => {
        storedSetting = { defaultTimezone: val.defaultTimezone };
        return tx;
      },
      onConflictDoUpdate: () => tx,
      returning: () => Promise.resolve([storedSetting]),
    };
    return fn(tx);
  },
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockAudit(...args),
}));

const { getTenantSettingsHandler, updateTenantSettingsHandler } =
  await import("./tenant-settings.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.get("/admin/tenant-settings", ...(getTenantSettingsHandler as any));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.patch("/admin/tenant-settings", ...(updateTenantSettingsHandler as any));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  storedSetting = null;
  mockAuth = {
    tenantId: "t-1",
    userId: "u-admin",
    roles: ["admin"],
    email: "admin@example.com",
  };
});

describe("GET /admin/tenant-settings", () => {
  it("returns null defaultTimezone when no row exists", async () => {
    const res = await makeApp().request("/admin/tenant-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { defaultTimezone: null },
    });
  });

  it("returns stored timezone when present", async () => {
    storedSetting = { defaultTimezone: "Europe/Berlin" };
    const res = await makeApp().request("/admin/tenant-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { defaultTimezone: "Europe/Berlin" },
    });
  });

  it("is accessible by agents and users (read-only org baseline)", async () => {
    mockAuth.roles = ["agent"];
    storedSetting = { defaultTimezone: "Asia/Kolkata" };
    const res = await makeApp().request("/admin/tenant-settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { defaultTimezone: "Asia/Kolkata" },
    });
  });
});

describe("PATCH /admin/tenant-settings", () => {
  it("updates timezone and records audit log", async () => {
    storedSetting = { defaultTimezone: null };
    const res = await makeApp().request("/admin/tenant-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTimezone: "America/New_York" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { defaultTimezone: "America/New_York" },
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: "t-1",
        actorId: "u-admin",
        action: "updated",
        resourceType: "tenant_settings",
        beforeSnapshot: { defaultTimezone: null },
        afterSnapshot: { defaultTimezone: "America/New_York" },
      }),
    );
  });

  it("allows setting timezone back to null", async () => {
    storedSetting = { defaultTimezone: "Europe/Paris" };
    const res = await makeApp().request("/admin/tenant-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTimezone: null }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { defaultTimezone: null },
    });
  });

  it("refuses non-admin callers with 403", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/tenant-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTimezone: "UTC" }),
    });

    expect(res.status).toBe(403);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("refuses invalid IANA timezone with 400", async () => {
    const res = await makeApp().request("/admin/tenant-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTimezone: "Invalid/Fake_Zone" }),
    });

    expect(res.status).toBe(400);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("canonicalizes valid non-canonical timezone identifiers", async () => {
    storedSetting = { defaultTimezone: null };
    const res = await makeApp().request("/admin/tenant-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTimezone: "utc" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { defaultTimezone: "UTC" },
    });
  });

  it("preserves standard IANA names for Asia/Kolkata and Europe/Kyiv without legacy aliases (#1158 G1)", async () => {
    for (const tz of [
      "Asia/Kolkata",
      "Europe/Kyiv",
      "Asia/Ho_Chi_Minh",
      "Asia/Kathmandu",
    ]) {
      storedSetting = { defaultTimezone: null };
      const res = await makeApp().request("/admin/tenant-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultTimezone: tz }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { defaultTimezone: tz },
      });
    }
  });

  it("rejects inverted Etc/GMT timezone identifiers", async () => {
    const res = await makeApp().request("/admin/tenant-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTimezone: "Etc/GMT+5" }),
    });

    expect(res.status).toBe(400);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("skips writing audit entry on no-op save", async () => {
    storedSetting = { defaultTimezone: "Europe/Berlin" };
    const res = await makeApp().request("/admin/tenant-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultTimezone: "Europe/Berlin" }),
    });

    expect(res.status).toBe(200);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
