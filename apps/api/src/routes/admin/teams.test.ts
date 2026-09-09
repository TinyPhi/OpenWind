import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["admin"] as string[],
    email: "test@example.com",
  },
}));

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

const mockTeamRow = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "t-aaa",
  name: "Platform Engineering",
  description: null,
  createdBy: "u-bbb",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

let insertShouldConflict = false;
let updateShouldConflict = false;
let updateReturnsRow = true;
let deleteReturnsRow = true;

vi.mock("@platform/db", () => ({
  db: {},
  teams: {
    id: "id",
    tenantId: "tenantId",
    name: "name",
    createdAt: "createdAt",
    deletedAt: "deletedAt",
  },
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => tx,
      from: () => tx,
      where: () => tx,
      orderBy: () => tx,
      limit: () => Promise.resolve([mockTeamRow]),
      insert: () => tx,
      values: () => tx,
      update: () => tx,
      set: () => tx,
      returning: () => {
        if (insertShouldConflict || updateShouldConflict) {
          const err = new Error("duplicate key");
          (err as unknown as { cause: { code: string } }).cause = {
            code: "23505",
          };
          throw err;
        }
        if (!updateReturnsRow || !deleteReturnsRow) return Promise.resolve([]);
        return Promise.resolve([mockTeamRow]);
      },
    };
    return fn(tx);
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  gt: (...args: unknown[]) => ({ op: "gt", args }),
  isNull: (...args: unknown[]) => ({ op: "isNull", args }),
}));

const { teamsRouter } = await import("./teams.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/teams", teamsRouter);
  return app;
}

// Reset ALL shared mutable fixture flags before every single test, not just
// per-describe -- these are module-level `let`s shared across every describe
// block in this file, and a flag flipped in one test otherwise leaks into
// the next describe block's tests (execution order, not describe order).
beforeEach(() => {
  mockAuth.roles = ["admin"];
  insertShouldConflict = false;
  updateShouldConflict = false;
  updateReturnsRow = true;
  deleteReturnsRow = true;
});

describe("GET /admin/teams — role enforcement", () => {
  it("returns 200 for admin role", async () => {
    const res = await makeApp().request("/admin/teams");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("data");
  });

  it("returns 200 for agent role (read allowed)", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/teams");
    expect(res.status).toBe(200);
  });

  it("returns 403 for a role with neither agent nor admin", async () => {
    mockAuth.roles = ["user"];
    const res = await makeApp().request("/admin/teams");
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/teams — role enforcement + create", () => {
  it("returns 403 for agent role (write is admin-only)", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Platform Engineering" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 for admin role with a valid body", async () => {
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Platform Engineering" }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 400 when name is missing", async () => {
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the team name already exists in this tenant (R3)", async () => {
    insertShouldConflict = true;
    const res = await makeApp().request("/admin/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Platform Engineering" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("PATCH /admin/teams/:id", () => {
  it("returns 200 when the team exists", async () => {
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 when the team does not exist (or belongs to another tenant)", async () => {
    updateReturnsRow = false;
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/teams/:id", () => {
  it("returns 204 on successful soft-delete", async () => {
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("returns 404 when the team does not exist", async () => {
    deleteReturnsRow = false;
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request(`/admin/teams/${mockTeamRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
