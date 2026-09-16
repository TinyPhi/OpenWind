import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const { mockAuth, mockWriteAuditEntry } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["admin"] as string[],
    email: "test@example.com",
  },
  mockWriteAuditEntry: vi.fn(),
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

const mockLabelRow = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "t-aaa",
  name: "bug",
  color: "#e11d48",
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
let getReturnsRow = true;

vi.mock("@platform/db", () => ({
  db: {},
  labels: {
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
      limit: () => Promise.resolve(getReturnsRow ? [mockLabelRow] : []),
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
        return Promise.resolve([mockLabelRow]);
      },
    };
    return fn(tx);
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => {
    mockWriteAuditEntry(...args);
    return Promise.resolve();
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (...args: unknown[]) => ({ op: "eq", args }),
  gt: (...args: unknown[]) => ({ op: "gt", args }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  isNull: (...args: unknown[]) => ({ op: "isNull", args }),
}));

const { labelsRouter } = await import("./labels.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/labels", labelsRouter);
  return app;
}

beforeEach(() => {
  mockAuth.roles = ["admin"];
  insertShouldConflict = false;
  updateShouldConflict = false;
  updateReturnsRow = true;
  deleteReturnsRow = true;
  getReturnsRow = true;
});

describe("GET /admin/labels — role enforcement", () => {
  it("returns 200 for admin role", async () => {
    const res = await makeApp().request("/admin/labels");
    expect(res.status).toBe(200);
  });

  it("returns 200 for agent role (read allowed)", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/labels");
    expect(res.status).toBe(200);
  });

  it("returns 403 for a role with neither agent nor admin", async () => {
    mockAuth.roles = ["user"];
    const res = await makeApp().request("/admin/labels");
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/labels/:id", () => {
  it("returns 200 with the label when it exists", async () => {
    const res = await makeApp().request(`/admin/labels/${mockLabelRow.id}`);
    expect(res.status).toBe(200);
  });

  it("returns 404 when the label does not exist (or belongs to another tenant)", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(`/admin/labels/${mockLabelRow.id}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/labels — role enforcement + create", () => {
  it("returns 403 for agent role (write is admin-only)", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bug", color: "#e11d48" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 for admin role with a valid body", async () => {
    const res = await makeApp().request("/admin/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bug", color: "#e11d48" }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 400 when color is not a valid hex code", async () => {
    const res = await makeApp().request("/admin/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bug", color: "red" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when the label name already exists in this tenant", async () => {
    insertShouldConflict = true;
    const res = await makeApp().request("/admin/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bug", color: "#e11d48" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("PATCH /admin/labels/:id", () => {
  it("returns 200 when the label exists", async () => {
    const res = await makeApp().request(`/admin/labels/${mockLabelRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#000000" }),
    });
    expect(res.status).toBe(200);
  });

  it("returns 404 when the label does not exist", async () => {
    updateReturnsRow = false;
    const res = await makeApp().request(`/admin/labels/${mockLabelRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#000000" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when renaming to a name that already exists in this tenant", async () => {
    updateShouldConflict = true;
    const res = await makeApp().request(`/admin/labels/${mockLabelRow.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bug" }),
    });
    expect(res.status).toBe(409);
  });
});

describe("DELETE /admin/labels/:id", () => {
  it("returns 204 on successful soft-delete", async () => {
    const res = await makeApp().request(`/admin/labels/${mockLabelRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("returns 404 when the label does not exist", async () => {
    deleteReturnsRow = false;
    const res = await makeApp().request(`/admin/labels/${mockLabelRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request(`/admin/labels/${mockLabelRow.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
