import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { PlatformAdminAuthContext } from "@platform/auth";

const freshState = vi.hoisted(() => ({ fresh: true }));
const mockLookupOrgId = vi.fn();
const mockListOrgUsers = vi.fn();
const mockSetUserOrgMetadata = vi.fn();

vi.mock("@platform/auth", () => ({
  requireFreshMfa:
    () =>
    async (
      c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
      next: Next,
    ): Promise<Response | void> => {
      if (!freshState.fresh) {
        return c.json({ error: "MFA_REAUTH_REQUIRED", message: "x" }, 403);
      }
      await next();
    },
  requirePlatformAdmin:
    () =>
    async (
      c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
      next: Next,
    ) => {
      c.set("platformAdmin", {
        userId: "pa-1",
        roles: ["platform_admin"],
        email: "ops@openwind.io",
        displayName: "Ops",
      });
      await next();
    },
  lookupOrgIdByTenantId: (...args: unknown[]) => mockLookupOrgId(...args),
  listOrgUsers: (...args: unknown[]) => mockListOrgUsers(...args),
  setUserOrgMetadata: (...args: unknown[]) => mockSetUserOrgMetadata(...args),
  // Real placement logic is covered in sandbox-org-template.test.ts; same shape here.
  sandboxOrgPlacement: (position: number) =>
    position < 2
      ? { department: "d", title: "Manager", reportsTo: null }
      : { department: "d", title: "Staff", reportsTo: 0 },
}));

const mockSelectRows = vi.fn();
const mockTx = {
  select: () => ({
    from: () => ({ where: () => ({ limit: () => mockSelectRows() }) }),
  }),
};
vi.mock("@platform/db", () => ({
  db: {},
  tenants: { id: "id", isSandbox: "isSandbox" },
  withPlatformAdminContext: (fn: (tx: unknown) => unknown) => fn(mockTx),
}));
vi.mock("drizzle-orm", () => ({ eq: (a: unknown, b: unknown) => [a, b] }));

const mockRunSync = vi.fn();
vi.mock("@platform/org-directory", () => ({
  runOrgDirectorySync: (...args: unknown[]) => mockRunSync(...args),
  ZitadelOrgSourceImporter: class {},
}));
vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { sandboxOrgTreeHandler } = await import("./sandbox-org-tree.js");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

function post(): Promise<Response> {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/sandboxes/:tenantId/seed-org-tree", ...sandboxOrgTreeHandler);
  return Promise.resolve(
    app.request(`/sandboxes/${TENANT_ID}/seed-org-tree`, { method: "POST" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  freshState.fresh = true;
  mockSelectRows.mockResolvedValue([{ id: TENANT_ID, isSandbox: true }]);
  mockLookupOrgId.mockResolvedValue("org-1");
  mockListOrgUsers.mockResolvedValue([
    { userId: "u-b", displayName: "Bob" },
    { userId: "u-a", displayName: "Alice" },
    { userId: "u-c", displayName: "Cara" },
  ]);
  mockSetUserOrgMetadata.mockResolvedValue(true);
  mockRunSync.mockResolvedValue({ status: "completed" });
});

describe("POST /sandboxes/:tenantId/seed-org-tree", () => {
  it("writes metadata in name order with managers resolved, then syncs", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { accounts: 3, syncStatus: "completed" },
    });
    expect(mockSetUserOrgMetadata.mock.calls).toEqual([
      ["u-a", { managerId: null, department: "d", title: "Manager" }],
      ["u-b", { managerId: null, department: "d", title: "Manager" }],
      ["u-c", { managerId: "u-a", department: "d", title: "Staff" }],
    ]);
    expect(mockRunSync).toHaveBeenCalledWith(
      TENANT_ID,
      expect.anything(),
      "pa-1",
    );
  });

  it("is 404 for a tenant that is not a sandbox, without touching Zitadel", async () => {
    mockSelectRows.mockResolvedValue([{ id: TENANT_ID, isSandbox: false }]);

    const res = await post();

    expect(res.status).toBe(404);
    expect(mockListOrgUsers).not.toHaveBeenCalled();
  });

  it("requires a fresh MFA code", async () => {
    freshState.fresh = false;

    const res = await post();

    expect(res.status).toBe(403);
    expect(mockSetUserOrgMetadata).not.toHaveBeenCalled();
  });

  it("returns 502 when an account could not be updated", async () => {
    mockSetUserOrgMetadata.mockResolvedValueOnce(false);

    const res = await post();

    expect(res.status).toBe(502);
  });

  it("returns 409 when the sandbox has no accounts", async () => {
    mockListOrgUsers.mockResolvedValue([]);

    const res = await post();

    expect(res.status).toBe(409);
    expect(mockRunSync).not.toHaveBeenCalled();
  });
});
