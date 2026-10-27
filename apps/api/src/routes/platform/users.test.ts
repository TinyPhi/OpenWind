import { auditResourceId } from "@platform/audit";
import type * as Audit from "@platform/audit";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Strategy: mock @platform/db (tenant_users rows) and the Zitadel client
// module at the service boundary — never mock the database itself for real
// queries, but withTenantContext here just returns a controlled array.

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => "sql"),
  and: vi.fn(() => "sql"),
  or: vi.fn(() => "sql"),
  sql: vi.fn(() => "sql"),
}));

const mockWithTenantContext = vi.fn();
const mockWriteAuditEntry = vi.fn();

const mockEraseUserFromTenant = vi.fn();

// The erasure statements themselves are exercised against real Postgres in
// tests/isolation/user-erasure-coverage.isolation.test.ts; here only the
// route's orchestration is checked.
const { mockEnqueueFlush } = vi.hoisted(() => ({ mockEnqueueFlush: vi.fn() }));
vi.mock("../../lib/superset-cache-flush-queue.js", () => ({
  enqueueSupersetCacheFlush: mockEnqueueFlush,
}));
const { mockEnqueueErasure } = vi.hoisted(() => ({
  mockEnqueueErasure: vi.fn(),
}));
vi.mock("../../lib/superset-erasure-queue.js", () => ({
  eraseUserInSuperset: mockEnqueueErasure,
}));
// What eraseUserInSuperset (unit-tested in superset-erasure-queue.test.ts) answers here.
const QUEUED = {
  status: "queued",
  switchIgnored: false,
  message: "The user's Superset data is being erased.",
};
// Export routes have their own test (user-export.test.ts).
vi.mock("./user-export.js", () => ({ userExportRouter: new Hono() }));
const { mockResolveTenantMembers } = vi.hoisted(() => ({
  mockResolveTenantMembers: vi.fn(),
}));
vi.mock("../../lib/ensure-user-refs.js", () => ({
  resolveTenantMembers: mockResolveTenantMembers,
}));
vi.mock("../../services/user-erasure.js", () => ({
  eraseUserFromTenant: (...args: unknown[]) => mockEraseUserFromTenant(...args),
}));

vi.mock("@platform/audit", async (importOriginal) => {
  // The real id mapping is part of what this test proves; only the DB write is replaced.
  const real = await importOriginal<typeof Audit>();
  return {
    ...real,
    writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
  };
});

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
const mockDeleteUser = vi.fn().mockResolvedValue(undefined);

vi.mock("../../lib/zitadel-management.js", () => ({
  listOrgUsers: (...args: unknown[]) => mockListOrgUsers(...args),
  listUserRolesByUserId: (...args: unknown[]) =>
    mockListUserRolesByUserId(...args),
  invalidateUserCache: () => mockInvalidateUserCache(),
  deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
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

  describe("DELETE /users/:userId", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockEraseUserFromTenant.mockResolvedValue({
        rotatedApiKeys: [],
        wasMember: true,
      });
      mockEnqueueErasure.mockResolvedValue(QUEUED);
      // Every id asked about is a member, unless a test says otherwise.
      mockResolveTenantMembers.mockImplementation(
        (_tenantId: string, ids: string[]) => Promise.resolve(new Set(ids)),
      );
    });

    it("refuses an id outside the admin's organisation with 404 and erases nothing", async () => {
      mockResolveTenantMembers.mockResolvedValueOnce(new Set());

      const res = await makeApp().request("/users/other-org-user", {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "NOT_FOUND",
        message: "No user with this id in this organisation",
      });
      expect(mockResolveTenantMembers).toHaveBeenCalledWith(
        "tenant-aaa",
        ["other-org-user"],
        "org-aaa",
      );
      expect(mockWithTenantContext).not.toHaveBeenCalled();
      expect(mockEraseUserFromTenant).not.toHaveBeenCalled();
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
      expect(mockDeleteUser).not.toHaveBeenCalled();
      expect(mockInvalidateUserCache).not.toHaveBeenCalled();
      expect(mockEnqueueFlush).not.toHaveBeenCalled();
      expect(mockEnqueueErasure).not.toHaveBeenCalled();
    });

    it("refuses with 404 when the membership lookup finds nothing, without asking the erasure", async () => {
      // e.g. an id erased earlier: no tenant_users row, and no longer one of the org's Zitadel users.
      mockResolveTenantMembers.mockResolvedValueOnce(new Set(["someone-else"]));

      const res = await makeApp().request("/users/already-erased", {
        method: "DELETE",
      });

      expect(res.status).toBe(404);
      expect(mockDeleteUser).not.toHaveBeenCalled();
    });

    it("passes the membership it read to the Superset step, and replies with what happened (#728)", async () => {
      mockEraseUserFromTenant.mockResolvedValueOnce({
        rotatedApiKeys: [],
        wasMember: false,
      });
      const notMember = {
        status: "not_member",
        switchIgnored: false,
        message:
          "Superset data was not erased because the user was not a member of this organisation.",
      };
      mockEnqueueErasure.mockResolvedValueOnce(notMember);
      mockWithTenantContext.mockImplementationOnce((_tenantId, cb) => cb({}));
      const res = await makeApp().request("/users/member-without-row", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      expect(mockEnqueueErasure).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: "member-without-row",
          wasMember: false,
        }),
      );
      expect(await res.json()).toEqual({ success: true, superset: notMember });
      // The cache flush is global, not personal, so it still runs.
      expect(mockEnqueueFlush).toHaveBeenCalledTimes(1);
    });

    it("audits each API key put on a forced rotation window (#688)", async () => {
      const rotateBy = new Date("2026-10-27T00:00:00.000Z");
      mockEraseUserFromTenant.mockResolvedValueOnce({
        rotatedApiKeys: [
          { id: "key-1", expiresAt: rotateBy },
          { id: "key-2", expiresAt: rotateBy },
        ],
      });
      mockWithTenantContext.mockImplementationOnce((_tenantId, cb) => cb({}));

      const res = await makeApp().request("/users/target-user-123", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const keyEntries = mockWriteAuditEntry.mock.calls
        // second argument is writeAuditEntry's AuditEntryInput
        .map(
          (c) =>
            c[1] as {
              resourceType: string;
              resourceId: string;
              metadata: unknown;
            },
        )
        .filter((e) => e.resourceType === "api_key");
      expect(keyEntries).toEqual([
        expect.objectContaining({
          resourceId: "key-1",
          metadata: {
            reason: "creator_erased",
            rotateBy: rotateBy.toISOString(),
          },
        }),
        expect.objectContaining({ resourceId: "key-2" }),
      ]);
    });

    it("erases the user inside the tenant transaction, audits it, and invalidates the user cache", async () => {
      const mockTx = { marker: "tx" };
      mockWithTenantContext.mockImplementationOnce((_tenantId, cb) =>
        cb(mockTx),
      );

      const res = await makeApp().request("/users/target-user-123", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      expect(mockWithTenantContext).toHaveBeenCalledTimes(1);
      const [tenantIdArg] = mockWithTenantContext.mock.calls[0] ?? [];
      expect(mockEraseUserFromTenant).toHaveBeenCalledWith(
        mockTx,
        tenantIdArg,
        "target-user-123",
      );
      expect(mockWriteAuditEntry).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({
          resourceType: "user",
          resourceId: auditResourceId("target-user-123"),
          action: "deleted",
          metadata: { userId: "target-user-123" },
        }),
      );
      expect(mockInvalidateUserCache).toHaveBeenCalled();
      expect(mockEnqueueFlush).toHaveBeenCalledWith(
        expect.any(String),
        "user_erased",
      );
      // The Zitadel user id is the subject Superset knows them by.
      expect(mockEnqueueErasure).toHaveBeenCalledWith({
        tenantId: tenantIdArg,
        subject: "target-user-123",
        wasMember: true,
      });
      expect(body.superset).toEqual(QUEUED);
    });

    it("queues no Superset erasure when the platform erasure fails (#728)", async () => {
      mockEraseUserFromTenant.mockRejectedValueOnce(new Error("boom"));
      mockWithTenantContext.mockImplementationOnce((_tenantId, cb) => cb({}));
      await makeApp().request("/users/target-user-123", { method: "DELETE" });
      expect(mockEnqueueErasure).not.toHaveBeenCalled();
    });

    it("queues no Superset cache flush when the erasure fails (#728)", async () => {
      mockEraseUserFromTenant.mockRejectedValueOnce(new Error("boom"));
      mockWithTenantContext.mockImplementationOnce((_tenantId, cb) => cb({}));
      await makeApp().request("/users/target-user-123", { method: "DELETE" });
      expect(mockEnqueueFlush).not.toHaveBeenCalled();
    });

    it("writes the erasure audit entry with a uuid resource id for a numeric Zitadel user id, keeping the real id in metadata", async () => {
      const mockTx = { marker: "tx" };
      mockWithTenantContext.mockImplementationOnce((_tenantId, cb) =>
        cb(mockTx),
      );

      const res = await makeApp().request("/users/256000000000000001", {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const deleted = mockWriteAuditEntry.mock.calls
        .map((c) => c[1] as { action: string })
        .find((e) => e.action === "deleted") as {
        resourceId: string;
        metadata: Record<string, unknown>;
      };
      // admin_audit_log.resource_id is a uuid column; a raw Zitadel id would make the insert throw
      // and roll the whole erasure back.
      expect(deleted.resourceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(deleted.metadata).toEqual({ userId: "256000000000000001" });
    });

    it("does not audit or touch Zitadel when the erasure fails", async () => {
      mockEraseUserFromTenant.mockRejectedValueOnce(new Error("boom"));
      mockWithTenantContext.mockImplementationOnce((_tenantId, cb) => cb({}));

      const res = await makeApp().request("/users/target-user-123", {
        method: "DELETE",
      });

      expect(res.status).toBe(500);
      expect(mockWriteAuditEntry).not.toHaveBeenCalled();
      expect(mockDeleteUser).not.toHaveBeenCalled();
    });
  });
});
