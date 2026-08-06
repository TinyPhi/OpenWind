import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Hoisted mutable auth fixture ──────────────────────────────────────────────

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["superadmin"] as string[],
    email: "test@example.com",
  },
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole:
    (...allowedRoles: string[]) =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      const auth = c.get("auth");
      if (!auth?.roles.some((r) => allowedRoles.includes(r))) {
        return c.json({ error: "FORBIDDEN" }, 403);
      }
      await next();
    },
}));

const mockRow = { id: 1, outboundNotificationsEnabled: true };

vi.mock("@platform/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([mockRow]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([
              { ...mockRow, updatedAt: new Date(), updatedBy: "u-bbb" },
            ]),
        }),
      }),
    }),
  },
  platformSettings: { id: "id" },
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

const { getPlatformSettingsHandler, updatePlatformSettingsHandler } =
  await import("./platform-settings.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/admin/platform-settings", ...getPlatformSettingsHandler);
  app.patch("/admin/platform-settings", ...updatePlatformSettingsHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /admin/platform-settings — superadmin required (#231)", () => {
  beforeEach(() => {
    mockAuth.roles = ["superadmin"];
  });

  it("returns 200 for superadmin role", async () => {
    const res = await makeApp().request("/admin/platform-settings");
    expect(res.status).toBe(200);
  });

  it("returns 403 for admin role — tenant admin cannot read global settings", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/admin/platform-settings");
    expect(res.status).toBe(403);
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/platform-settings");
    expect(res.status).toBe(403);
  });
});

describe("PATCH /admin/platform-settings — superadmin required (#231)", () => {
  beforeEach(() => {
    mockAuth.roles = ["superadmin"];
  });

  it("returns 200 for superadmin role", async () => {
    const res = await makeApp().request("/admin/platform-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outboundNotificationsEnabled: false }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 403 for admin role — tenant admin cannot toggle global notification kill-switch", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/admin/platform-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outboundNotificationsEnabled: false }),
    });
    expect(res.status).toBe(403);
  });
});
