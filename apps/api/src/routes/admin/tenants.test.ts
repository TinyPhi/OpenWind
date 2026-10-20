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
  mockEnv: {
    PLATFORM_ORG_ID: undefined as string | undefined,
    NODE_ENV: "test" as string,
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
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireIntrospection: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

vi.mock("@platform/config", async () => {
  const { z } = await import("zod");
  return {
    get env() {
      return mockEnv;
    },
    RetentionPatchSchema: z
      .object({
        retention_days: z.number().int().min(7).max(3650).nullable().optional(),
        retention_hold: z.boolean().nullable().optional(),
        confirmShorten: z.boolean().optional(),
      })
      .strict()
      .refine(
        (v) => v.retention_days !== undefined || v.retention_hold !== undefined,
        { message: "at least one retention field is required" },
      ),
  };
});

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

const {
  mockSuspendTenant,
  mockReactivateTenant,
  mockScheduleTenantDeletion,
  mockUpdateTenantRetention,
} = vi.hoisted(() => ({
  mockSuspendTenant: vi.fn(),
  mockReactivateTenant: vi.fn(),
  mockScheduleTenantDeletion: vi.fn(),
  mockUpdateTenantRetention: vi.fn(),
}));

vi.mock("../../lib/tenant-lifecycle.js", () => ({
  ProvisionTenantSchema: {
    safeParse: () => ({ success: false, error: new Error("not tested") }),
  },
  TenantLifecycleError: class TenantLifecycleError extends Error {
    code: string;
    meta?: Record<string, unknown>;
    constructor(code: string, meta?: Record<string, unknown>) {
      super(code);
      this.code = code;
      if (meta) this.meta = meta;
    }
  },
  provisionTenant: vi.fn(),
  suspendTenant: mockSuspendTenant,
  reactivateTenant: mockReactivateTenant,
  scheduleTenantDeletion: mockScheduleTenantDeletion,
  updateTenantRetention: mockUpdateTenantRetention,
}));

const {
  listTenantsHandlers,
  getTenantHandlers,
  suspendTenantHandlers,
  reactivateTenantHandlers,
  deleteTenantHandlers,
  updateTenantRetentionHandlers,
} = await import("./tenants.js");

const { TenantLifecycleError: TenantLifecycleErrorMock } =
  await import("../../lib/tenant-lifecycle.js");

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/", ...listTenantsHandlers);
  app.get("/:id", ...getTenantHandlers);
  app.patch("/:id/suspend", ...suspendTenantHandlers);
  app.patch("/:id/reactivate", ...reactivateTenantHandlers);
  app.patch("/:id/retention", ...updateTenantRetentionHandlers);
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
    mockEnv.NODE_ENV = "test";
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

  it("refuses every tenant-management route in production when PLATFORM_ORG_ID is unset (#1015)", async () => {
    mockEnv.NODE_ENV = "production";
    const app = makeApp();
    const calls: Array<[string, string]> = [
      ["GET", "/"],
      ["GET", `/${TENANT_ID}`],
      ["PATCH", `/${TENANT_ID}/suspend`],
      ["PATCH", `/${TENANT_ID}/reactivate`],
      ["PATCH", `/${TENANT_ID}/retention`],
      ["DELETE", `/${TENANT_ID}`],
    ];
    for (const [method, path] of calls) {
      const res = await app.request(path, {
        method,
        ...(method === "GET"
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: "{}",
            }),
      });
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 404`);
    }
    expect(mockSuspendTenant).not.toHaveBeenCalled();
    expect(mockScheduleTenantDeletion).not.toHaveBeenCalled();
    expect(mockUpdateTenantRetention).not.toHaveBeenCalled();
  });

  it("still serves them in production when the caller is in PLATFORM_ORG_ID", async () => {
    mockEnv.NODE_ENV = "production";
    mockEnv.PLATFORM_ORG_ID = "t-platform";
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

describe("PATCH /admin/tenants/:id/retention (#637)", () => {
  const patch = (body: unknown) =>
    makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.tenantId = "t-platform";
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    mockEnv.NODE_ENV = "test";
    mockUpdateTenantRetention.mockResolvedValue({
      before: { retention_days: 90 },
      after: { retention_days: 120 },
    });
  });

  it("passes the patch and the caller to the lifecycle service and returns before and after", async () => {
    const res = await patch({ retention_days: 120 });
    expect(res.status).toBe(200);
    expect(mockUpdateTenantRetention).toHaveBeenCalledWith(
      TENANT_ID,
      "u-superadmin",
      { retention_days: 120 },
    );
    const json = (await res.json()) as { data: { after: unknown } };
    expect(json.data.after).toEqual({ retention_days: 120 });
  });

  it("rejects an empty body, an out-of-bounds value and unknown keys with 422", async () => {
    for (const body of [{}, { retention_days: 3 }, { rate_limit_per_min: 5 }]) {
      const res = await patch(body);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(mockUpdateTenantRetention).not.toHaveBeenCalled();
  });

  it("accepts null to clear a key", async () => {
    const res = await patch({ retention_hold: null });
    expect(res.status).toBe(200);
  });

  it("returns 404 for a caller outside the platform org", async () => {
    mockAuth.tenantId = "t-customer";
    const res = await patch({ retention_days: 120 });
    expect(res.status).toBe(404);
    expect(mockUpdateTenantRetention).not.toHaveBeenCalled();
  });

  it("returns 404 when the tenant does not exist", async () => {
    mockUpdateTenantRetention.mockRejectedValue(
      new TenantLifecycleErrorMock("TENANT_NOT_FOUND"),
    );
    expect((await patch({ retention_days: 120 })).status).toBe(404);
  });

  it("returns 422 naming the fields when a shortening is not confirmed", async () => {
    mockUpdateTenantRetention.mockRejectedValue(
      new TenantLifecycleErrorMock("CONFIRM_SHORTEN_REQUIRED", {
        fields: ["retention_days"],
      }),
    );
    const res = await patch({ retention_days: 8 });
    expect(res.status).toBe(422);
    const json = (await res.json()) as {
      error: string;
      message: string;
      fields: string[];
    };
    expect(json.error).toBe("CONFIRM_SHORTEN_REQUIRED");
    expect(json.message).toContain("confirmShorten");
    expect(json.fields).toEqual(["retention_days"]);
  });
});
