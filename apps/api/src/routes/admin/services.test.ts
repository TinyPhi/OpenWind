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

const mockServiceRow = {
  id: "22222222-2222-4222-8222-222222222222",
  tenantId: "t-aaa",
  name: "Payments API",
  description: null,
  teamId: null,
  createdBy: "u-bbb",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

let teamRefValid = true;
let getReturnsRow = true;

vi.mock("@platform/teams", () => ({
  validateCrossTenantRefs: async (
    refs: { fieldName: string; refId: string }[],
    lookup: (ids: string[]) => Promise<Set<string>>,
  ) => {
    const validIds = await lookup(refs.map((r) => r.refId));
    return refs
      .filter((r) => !validIds.has(r.refId))
      .map((r) => ({
        field: r.fieldName,
        code: "INVALID_REFERENCE",
        message: "Referenced resource does not exist or is not accessible",
        meta: { refId: r.refId },
      }));
  },
  lookupValidIdsInTable: () => async () =>
    teamRefValid
      ? new Set(["11111111-1111-4111-8111-111111111111"])
      : new Set(),
}));

vi.mock("@platform/db", () => ({
  db: {},
  teams: { id: "id", tenantId: "tenantId", deletedAt: "deletedAt" },
  services: {
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
      limit: () => Promise.resolve(getReturnsRow ? [mockServiceRow] : []),
      insert: () => tx,
      values: () => tx,
      update: () => tx,
      set: () => tx,
      returning: () => Promise.resolve([mockServiceRow]),
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

const { servicesRouter } = await import("./services.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/services", servicesRouter);
  return app;
}

// Reset shared mutable fixture flags before every test (module-level `let`s
// leak across describe blocks otherwise, per teams.test.ts's fix).
beforeEach(() => {
  mockAuth.roles = ["admin"];
  teamRefValid = true;
  getReturnsRow = true;
});

describe("GET /admin/services — role enforcement", () => {
  it("returns 200 for admin role", async () => {
    const res = await makeApp().request("/admin/services");
    expect(res.status).toBe(200);
  });

  it("returns 403 for a role with neither agent nor admin", async () => {
    mockAuth.roles = ["user"];
    const res = await makeApp().request("/admin/services");
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/services/:id", () => {
  it("returns 200 with the service when it exists", async () => {
    const res = await makeApp().request(`/admin/services/${mockServiceRow.id}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(mockServiceRow.id);
  });

  it("returns 404 when the service does not exist (or belongs to another tenant)", async () => {
    getReturnsRow = false;
    const res = await makeApp().request(`/admin/services/${mockServiceRow.id}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/services — team_id cross-tenant validation (R1d)", () => {
  it("returns 201 when teamId is omitted", async () => {
    const res = await makeApp().request("/admin/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Payments API" }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 201 when teamId belongs to the same tenant", async () => {
    teamRefValid = true;
    const res = await makeApp().request("/admin/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Payments API",
        teamId: "11111111-1111-4111-8111-111111111111",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 422 when teamId does not resolve within the tenant (cross-tenant or missing)", async () => {
    teamRefValid = false;
    const res = await makeApp().request("/admin/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Payments API",
        teamId: "11111111-1111-4111-8111-111111111111",
      }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 403 for agent role", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/admin/services", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Payments API" }),
    });
    expect(res.status).toBe(403);
  });
});
