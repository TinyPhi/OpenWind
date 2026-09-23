import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";

// Same mocking strategy as platform/users.test.ts: mock @platform/db (tenant_users
// rows) and the Zitadel client module at the service boundary.

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
  savedViews: { tenantId: "tenantId", userId: "userId" },
  notificationRecipients: { tenantId: "tenantId", userId: "userId" },
  ticketAlerts: { tenantId: "tenantId", createdBy: "createdBy" },
  accessRequests: {
    tenantId: "tenantId",
    requesterId: "requesterId",
    resolvedBy: "resolvedBy",
  },
  apiKeys: {
    tenantId: "tenantId",
    createdBy: "createdBy",
    revokedBy: "revokedBy",
  },
  entityInstances: {
    tenantId: "tenantId",
    createdBy: "createdBy",
    assignedTo: "assignedTo",
  },
  workflows: {
    tenantId: "tenantId",
    createdBy: "createdBy",
    assignedTo: "assignedTo",
  },
  workflowEvents: {
    tenantId: "tenantId",
    triggeredBy: "triggeredBy",
    actorId: "actorId",
  },
  attachments: {
    tenantId: "tenantId",
    uploadedBy: "uploadedBy",
    actingPersonId: "actingPersonId",
  },
  idempotencyKeys: {
    tenantId: "tenantId",
    userId: "userId",
  },
}));

let currentRoles: string[] = ["admin"];

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
        roles: currentRoles,
      } as AuthContext);
      return next();
    },
  requireRole:
    (...allowed: string[]) =>
    async (
      c: {
        get: (k: string) => AuthContext;
        json: (b: unknown, s: number) => Response;
      },
      next: () => Promise<void>,
    ) => {
      const { roles } = c.get("auth");
      if (!roles.some((r) => allowed.includes(r))) {
        return c.json({ error: "FORBIDDEN" }, 403);
      }
      return next();
    },
}));

const mockListOrgUsers = vi.fn();
const mockListUserRolesByUserId = vi.fn();
const mockInvalidateUserCache = vi.fn();

vi.mock("../../lib/zitadel-management.js", () => ({
  listOrgUsers: (...args: unknown[]) => mockListOrgUsers(...args),
  listUserRolesByUserId: (...args: unknown[]) =>
    mockListUserRolesByUserId(...args),
  invalidateUserCache: () => mockInvalidateUserCache(),
  deleteUser: vi.fn().mockResolvedValue(undefined),
}));

const { membersRouter } = await import("./members.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.route("/admin/members", membersRouter);
  return app;
}

describe("GET /admin/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentRoles = ["admin"];
  });

  it("returns agents, admins, and users -- any org member is a valid on-call assignee", async () => {
    mockListOrgUsers.mockResolvedValueOnce([
      {
        userId: "u-user",
        email: "c@x.com",
        displayName: "User One",
        loginName: "c",
      },
      {
        userId: "u-agent",
        email: "a@x.com",
        displayName: "Agent One",
        loginName: "a",
      },
      {
        userId: "u-admin",
        email: "ad@x.com",
        displayName: "Admin One",
        loginName: "ad",
      },
    ]);
    mockListUserRolesByUserId.mockResolvedValueOnce(
      new Map([
        ["u-user", ["user"]],
        ["u-agent", ["agent"]],
        ["u-admin", ["admin"]],
      ]),
    );
    mockWithTenantContext.mockResolvedValueOnce([]);

    const res = await makeApp().request("/admin/members");
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data as { userId: string }[]).map((u) => u.userId);
    expect(ids).toEqual(
      expect.arrayContaining(["u-user", "u-agent", "u-admin"]),
    );
  });

  it("excludes an org member with no role grant at all", async () => {
    mockListOrgUsers.mockResolvedValueOnce([
      {
        userId: "u-norole",
        email: "n@x.com",
        displayName: "No Role",
        loginName: "n",
      },
      {
        userId: "u-admin",
        email: "ad@x.com",
        displayName: "Admin One",
        loginName: "ad",
      },
    ]);
    mockListUserRolesByUserId.mockResolvedValueOnce(
      new Map([["u-admin", ["admin"]]]),
    );
    mockWithTenantContext.mockResolvedValueOnce([]);

    const res = await makeApp().request("/admin/members");
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data as { userId: string }[]).map((u) => u.userId);
    expect(ids).toContain("u-admin");
    expect(ids).not.toContain("u-norole");
  });

  it("rejects a non-admin caller with 403", async () => {
    currentRoles = ["agent"];

    const res = await makeApp().request("/admin/members");
    expect(res.status).toBe(403);
  });
});
