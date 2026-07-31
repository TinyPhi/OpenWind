import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Hoisted mutable auth fixture ──────────────────────────────────────────────

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["admin"] as string[],
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

const mockViewConfigRow = {
  id: 1,
  tenantId: "t-aaa",
  entityTypeSlug: "ticket",
  listColumns: ["subject"],
  detailLayout: [],
  formFieldOrder: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

vi.mock("@platform/db", () => ({
  db: {},
  viewConfigs: { tenantId: "tenantId", entityTypeSlug: "entityTypeSlug" },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => tx,
      from: () => tx,
      where: () => tx,
      limit: () => Promise.resolve([mockViewConfigRow]),
      insert: () => tx,
      values: () => tx,
      onConflictDoUpdate: () => tx,
      returning: () =>
        Promise.resolve([{ ...mockViewConfigRow, isNew: false }]),
    };
    return fn(tx);
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

const { viewConfigsRouter } = await import("./index.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/view-configs", viewConfigsRouter);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /admin/view-configs/:entityType — role enforcement (#225)", () => {
  beforeEach(() => {
    mockAuth.roles = ["admin"];
  });

  it("returns 200 for admin role", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/admin/view-configs/ticket");
    expect(res.status).toBe(200);
  });

  it("returns 200 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/view-configs/ticket");
    expect(res.status).toBe(200);
  });

  it("returns 403 for user role — any authenticated user could previously read view configs", async () => {
    mockAuth.roles = ["user"];
    const res = await makeApp().request("/admin/view-configs/ticket");
    expect(res.status).toBe(403);
  });
});

describe("PATCH /admin/view-configs/:entityType — role unchanged (admin only)", () => {
  it("returns 200 for admin role", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/admin/view-configs/ticket", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listColumns: ["subject"] }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 403 for agent role on PATCH", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/view-configs/ticket", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listColumns: ["subject"] }),
    });
    expect(res.status).toBe(403);
  });
});
