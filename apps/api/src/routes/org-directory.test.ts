/**
 * org-directory.test.ts — docs/specs/org-directory.md T5, T6.
 *
 * @platform/org-directory is mocked at the service boundary (it's the query/
 * sync engine under test elsewhere, in packages/org-directory and the
 * isolation suite) -- this file only exercises this route's own auth/role
 * wiring and response shaping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["agent"] as string[],
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

vi.mock("@platform/db", () => ({ db: {} }));

const mockGetOrgTree = vi.fn();
const mockGetChainToRoot = vi.fn();
const mockGetReportsByLevel = vi.fn();
const mockGetSyncStatus = vi.fn();
const mockRunOrgDirectorySync = vi.fn();

vi.mock("@platform/org-directory", () => ({
  getOrgTree: (...args: unknown[]) => mockGetOrgTree(...args),
  getChainToRoot: (...args: unknown[]) => mockGetChainToRoot(...args),
  getReportsByLevel: (...args: unknown[]) => mockGetReportsByLevel(...args),
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
  runOrgDirectorySync: (...args: unknown[]) => mockRunOrgDirectorySync(...args),
  ZitadelOrgSourceImporter: class {},
}));

const mockWriteAuditEntry = vi.fn();
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { orgDirectoryRouter } = await import("./org-directory.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.roles = ["agent"];
});

function buildApp(): Hono {
  const app = new Hono();
  app.route("/org-directory", orgDirectoryRouter);
  return app;
}

describe("GET /org-directory/tree", () => {
  it("returns the tenant's tree for any authenticated user", async () => {
    mockAuth.roles = ["agent"];
    mockGetOrgTree.mockResolvedValue({
      root: { name: "Acme" },
      nodesByParentId: {},
    });

    const res = await buildApp().request("/org-directory/tree");

    expect(res.status).toBe(200);
    expect(mockGetOrgTree).toHaveBeenCalledWith("t-aaa");
  });
});

describe("GET /org-directory/chain/:userId", () => {
  it("returns the upward chain for the given user", async () => {
    mockGetChainToRoot.mockResolvedValue([{ userId: "u1" }]);

    const res = await buildApp().request("/org-directory/chain/u1");
    const body = (await res.json()) as { data: unknown };

    expect(res.status).toBe(200);
    expect(mockGetChainToRoot).toHaveBeenCalledWith("t-aaa", "u1");
    expect(body.data).toEqual([{ userId: "u1" }]);
  });
});

describe("GET /org-directory/reports/:userId", () => {
  it("returns reports grouped by level", async () => {
    mockGetReportsByLevel.mockResolvedValue([[{ userId: "direct-1" }]]);

    const res = await buildApp().request("/org-directory/reports/u1");

    expect(res.status).toBe(200);
    expect(mockGetReportsByLevel).toHaveBeenCalledWith("t-aaa", "u1");
  });
});

describe("POST /org-directory/sync", () => {
  it("rejects a non-admin trying to trigger a manual sync", async () => {
    mockAuth.roles = ["agent"];

    const res = await buildApp().request("/org-directory/sync", {
      method: "POST",
    });

    expect(res.status).toBe(403);
    expect(mockRunOrgDirectorySync).not.toHaveBeenCalled();
  });

  it("allows an admin to trigger a manual sync and audits it on success", async () => {
    mockAuth.roles = ["admin"];
    mockRunOrgDirectorySync.mockResolvedValue({
      status: "completed",
      syncedAt: new Date().toISOString(),
      employeeCount: 3,
      cyclesBroken: 0,
      reparented: 0,
    });

    const res = await buildApp().request("/org-directory/sync", {
      method: "POST",
    });
    const body = (await res.json()) as { data: { status: string } };

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("completed");
    expect(mockWriteAuditEntry).toHaveBeenCalled();
  });

  it("returns already_running as a normal 200, not an error", async () => {
    mockAuth.roles = ["admin"];
    mockRunOrgDirectorySync.mockResolvedValue({
      status: "already_running",
      syncedAt: null,
      employeeCount: 0,
      cyclesBroken: 0,
      reparented: 0,
    });

    const res = await buildApp().request("/org-directory/sync", {
      method: "POST",
    });
    const body = (await res.json()) as { data: { status: string } };

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("already_running");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("audits a failed sync, not just the logger (review finding: a failed admin-triggered write needs a durable audit record, not just a log line)", async () => {
    mockAuth.roles = ["admin"];
    mockRunOrgDirectorySync.mockResolvedValue({
      status: "failed",
      syncedAt: null,
      employeeCount: 0,
      cyclesBroken: 0,
      reparented: 0,
    });

    const res = await buildApp().request("/org-directory/sync", {
      method: "POST",
    });
    const body = (await res.json()) as { data: { status: string } };

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("failed");
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "sync_failed" }),
    );
  });
});
