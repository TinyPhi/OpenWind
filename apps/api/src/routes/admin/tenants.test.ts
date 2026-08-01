import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Hoisted mutable fixtures ───────────────────────────────────────────────────

const { mockAuth, mockEnv } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-platform",
    userId: "u-superadmin",
    roles: ["superadmin"] as string[],
    email: "sa@example.com",
  },
  mockEnv: { PLATFORM_ORG_ID: undefined as string | undefined },
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", mockAuth as AuthContext);
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireIntrospection: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("@platform/config", () => ({
  get env() {
    return mockEnv;
  },
}));

const fakeTenant = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Acme",
  slug: "acme",
  plan: "starter",
  status: "active",
  suspendedAt: null,
  deletionScheduledAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

// Chainable + thenable mock: supports both .limit().offset() (list) and
// .limit() alone (get) by resolving via both .offset() and .then().
function makeQueryChain(rows: unknown[]) {
  type Q = Record<string, (...args: unknown[]) => unknown>;
  const q: Q = {};
  q.select = () => q;
  q.from = () => q;
  q.where = () => q;
  q.orderBy = () => q;
  q.limit = () => q;
  q.offset = () => Promise.resolve(rows);
  // Thenable so `await db.select()...limit(1)` resolves to `rows` without
  // needing a trailing .offset() call.
  (q as Record<string, unknown>).then = (
    resolve: (v: unknown) => void,
    _reject?: unknown,
  ) => Promise.resolve(rows).then(resolve);
  return q;
}

const mockDb = makeQueryChain([fakeTenant]);

vi.mock("@platform/db", () => ({
  db: mockDb,
  tenants: {},
}));

vi.mock("drizzle-orm", () => ({
  asc: vi.fn(),
  eq: vi.fn(),
}));

const { mockSuspendTenant, mockReactivateTenant, mockScheduleTenantDeletion } =
  vi.hoisted(() => ({
    mockSuspendTenant: vi.fn(),
    mockReactivateTenant: vi.fn(),
    mockScheduleTenantDeletion: vi.fn(),
  }));

vi.mock("../../lib/tenant-lifecycle.js", () => ({
  ProvisionTenantSchema: {
    safeParse: () => ({ success: false, error: new Error("not tested") }),
  },
  TenantLifecycleError: class TenantLifecycleError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  provisionTenant: vi.fn(),
  suspendTenant: mockSuspendTenant,
  reactivateTenant: mockReactivateTenant,
  scheduleTenantDeletion: mockScheduleTenantDeletion,
}));

const {
  listTenantsHandlers,
  getTenantHandlers,
  suspendTenantHandlers,
  reactivateTenantHandlers,
  deleteTenantHandlers,
} = await import("./tenants.js");

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/", ...listTenantsHandlers);
  app.get("/:id", ...getTenantHandlers);
  app.patch("/:id/suspend", ...suspendTenantHandlers);
  app.patch("/:id/reactivate", ...reactivateTenantHandlers);
  app.delete("/:id", ...deleteTenantHandlers);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("admin tenant routes — PLATFORM_ORG_ID guard (#251)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.tenantId = "t-platform";
    mockAuth.roles = ["superadmin"];
    mockEnv.PLATFORM_ORG_ID = undefined;
    mockSuspendTenant.mockResolvedValue(undefined as void);
    mockReactivateTenant.mockResolvedValue(undefined as void);
    mockScheduleTenantDeletion.mockResolvedValue({
      deletionScheduledAt: new Date(),
    });
  });

  it("GET /:id passes when PLATFORM_ORG_ID is unset (dev/test)", async () => {
    const res = await makeApp().request(`/${TENANT_ID}`);
    expect(res.status).toBe(200);
  });

  it("GET /:id passes when caller's tenantId matches PLATFORM_ORG_ID", async () => {
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    const res = await makeApp().request(`/${TENANT_ID}`);
    expect(res.status).toBe(200);
  });

  it("GET /:id returns 404 when caller's tenantId does not match PLATFORM_ORG_ID", async () => {
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    mockAuth.tenantId = "t-customer";

    const res = await makeApp().request(`/${TENANT_ID}`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect((json as { error: string }).error).toBe("NOT_FOUND");
  });

  it("PATCH /:id/suspend returns 404 when caller's tenantId does not match PLATFORM_ORG_ID", async () => {
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    mockAuth.tenantId = "t-customer";

    const res = await makeApp().request(`/${TENANT_ID}/suspend`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("PATCH /:id/reactivate returns 404 when caller's tenantId does not match PLATFORM_ORG_ID", async () => {
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    mockAuth.tenantId = "t-customer";

    const res = await makeApp().request(`/${TENANT_ID}/reactivate`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /:id returns 404 when caller's tenantId does not match PLATFORM_ORG_ID", async () => {
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    mockAuth.tenantId = "t-customer";

    const res = await makeApp().request(`/${TENANT_ID}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("GET / passes when PLATFORM_ORG_ID is unset (dev/test)", async () => {
    const res = await makeApp().request("/");
    expect(res.status).toBe(200);
  });

  it("GET / returns 404 when caller's tenantId does not match PLATFORM_ORG_ID", async () => {
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    mockAuth.tenantId = "t-customer";

    const res = await makeApp().request("/");
    expect(res.status).toBe(404);
    const json = await res.json();
    expect((json as { error: string }).error).toBe("NOT_FOUND");
  });

  it("GET / passes when caller's tenantId matches PLATFORM_ORG_ID", async () => {
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    const res = await makeApp().request("/");
    expect(res.status).toBe(200);
  });
});
