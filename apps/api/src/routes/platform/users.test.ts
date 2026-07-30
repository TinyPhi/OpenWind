import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Strategy: mock @platform/db (tenant_users rows) and the Zitadel client
// module at the service boundary — never mock the database itself for real
// queries, but withTenantContext here just returns a controlled array.

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => "sql"),
}));

const mockWithTenantContext = vi.fn();

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (...args: unknown[]) => mockWithTenantContext(...args),
  tenantUsers: {
    tenantId: "tenantId",
    userId: "userId",
    email: "email",
    displayName: "displayName",
  },
}));

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("auth", {
        tenantId: "tenant-aaa",
        orgId: "org-aaa",
        userId: "user-bbb",
        roles: ["user"],
      } as AuthContext);
      return next();
    },
  requireRole:
    (..._roles: string[]) =>
    async (_c: unknown, next: () => Promise<void>) =>
      next(),
}));

const mockListOrgUsers = vi.fn();
const mockListUserRolesByUserId = vi.fn();
const mockInvalidateUserCache = vi.fn();

vi.mock("../../lib/zitadel-management.js", () => ({
  listOrgUsers: (...args: unknown[]) => mockListOrgUsers(...args),
  listUserRolesByUserId: (...args: unknown[]) =>
    mockListUserRolesByUserId(...args),
  invalidateUserCache: () => mockInvalidateUserCache(),
}));

const { usersRouter } = await import("./users.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/users", usersRouter);
  return app;
}

describe("GET /users", () => {
  beforeEach(() => vi.clearAllMocks());

  it("excludes agents and admins, returning only users with the 'user' role", async () => {
    mockListOrgUsers.mockResolvedValueOnce([
      {
        userId: "u-customer",
        email: "c@x.com",
        displayName: "Customer One",
        loginName: "c",
      },
      {
        userId: "u-agent",
        email: "a@x.com",
        displayName: "Agent One",
        loginName: "a",
      },
    ]);
    mockListUserRolesByUserId.mockResolvedValueOnce(
      new Map([
        ["u-customer", ["user"]],
        ["u-agent", ["agent"]],
      ]),
    );
    mockWithTenantContext.mockResolvedValueOnce([]);

    const res = await makeApp().request("/users");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].userId).toBe("u-customer");
    expect(body.data[0].roles).toEqual(["user"]);
    expect(mockListUserRolesByUserId).toHaveBeenCalledWith("org-aaa");
  });

  it("includes all of a user's roles, not just 'user', when they hold more than one", async () => {
    mockListOrgUsers.mockResolvedValueOnce([
      {
        userId: "u-dual",
        email: "d@x.com",
        displayName: "Dual Role",
        loginName: "d",
      },
    ]);
    mockListUserRolesByUserId.mockResolvedValueOnce(
      new Map([["u-dual", ["user", "agent"]]]),
    );
    mockWithTenantContext.mockResolvedValueOnce([]);

    const res = await makeApp().request("/users");
    const body = await res.json();
    expect(body.data[0].roles).toEqual(["user", "agent"]);
  });

  it("excludes a DB-only user (e.g. instance admin) that doesn't hold the 'user' role", async () => {
    mockListOrgUsers.mockResolvedValueOnce([]);
    mockListUserRolesByUserId.mockResolvedValueOnce(new Map());
    mockWithTenantContext.mockResolvedValueOnce([
      {
        userId: "u-admin",
        email: "admin@x.com",
        displayName: "Instance Admin",
      },
    ]);

    const res = await makeApp().request("/users");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});
