import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as ConfigModule from "@platform/config";

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
    RETENTION_REQUIRE_SHORTEN_CONFIRM: true as boolean,
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

vi.mock("@platform/config", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    get env() {
      return mockEnv;
    },
  };
});

const fakeTenant = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Acme",
  slug: "acme",
  plan: "starter",
  status: "active",
  config: {
    retention_days: 90,
    retention_comment_days: 90,
    retention_evidence_days: 2555,
    retention_hold: false,
  } as Record<string, unknown>,
  suspendedAt: null,
  deletionScheduledAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

let currentDbRows: unknown[] = [fakeTenant];
let lastDbUpdateSet: Record<string, unknown> | null = null;

// Chainable + thenable mock: supports both .limit().offset() (list) and
// .limit() alone (get) by resolving via both .offset() and .then().
function makeQueryChain() {
  type Q = Record<string, (...args: unknown[]) => unknown>;
  const q: Q = {};
  q.select = () => q;
  q.from = () => q;
  q.where = () => q;
  q.orderBy = () => q;
  q.limit = () => q;
  q.offset = () => Promise.resolve(currentDbRows);
  q.for = () => q;
  q.update = () => q;
  q.set = (val: Record<string, unknown>) => {
    lastDbUpdateSet = val;
    return q;
  };
  // Thenable so `await db.select()...limit(1)` resolves to `rows` without
  // needing a trailing .offset() call.
  (q as Record<string, unknown>).then = (
    resolve: (v: unknown) => void,
    _reject?: unknown,
  ) => Promise.resolve(currentDbRows).then(resolve);
  return q;
}

const mockDb = makeQueryChain();

const { mockWriteAuditEntry } = vi.hoisted(() => ({
  mockWriteAuditEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

vi.mock("@platform/db", () => ({
  db: mockDb,
  tenants: {},
  withTenantContext: vi.fn(async (_tenantId, fn) => fn(mockDb)),
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
  updateTenantRetentionHandlers,
} = await import("./tenants.js");

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
    mockEnv.RETENTION_REQUIRE_SHORTEN_CONFIRM = true;
    fakeTenant.config = {
      retention_days: 90,
      retention_comment_days: 90,
      retention_evidence_days: 2555,
      retention_hold: false,
    };
    mockSuspendTenant.mockResolvedValue(undefined as void);
    mockReactivateTenant.mockResolvedValue(undefined as void);
    mockScheduleTenantDeletion.mockResolvedValue({
      deletionScheduledAt: new Date(),
    });
    mockWriteAuditEntry.mockResolvedValue(undefined);
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
              body:
                method === "PATCH" && path.endsWith("/retention")
                  ? JSON.stringify({ retention_days: 90 })
                  : "{}",
            }),
      });
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 404`);
    }
    expect(mockSuspendTenant).not.toHaveBeenCalled();
    expect(mockScheduleTenantDeletion).not.toHaveBeenCalled();
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

  it("PATCH /:id/retention returns 404 when caller's tenantId does not match PLATFORM_ORG_ID", async () => {
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    mockAuth.tenantId = "t-customer";

    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 180 }),
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.tenantId = "t-platform";
    mockAuth.userId = "u-superadmin";
    mockAuth.roles = ["superadmin"];
    mockEnv.PLATFORM_ORG_ID = undefined;
    mockEnv.NODE_ENV = "test";
    currentDbRows = [fakeTenant];
    lastDbUpdateSet = null;
    fakeTenant.config = {
      retention_days: 90,
      retention_comment_days: 90,
      retention_evidence_days: 2555,
      retention_hold: false,
    };
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("returns 400 when body is empty", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when retention fields are below minimum bounds", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 3 }), // min is 7
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when retention fields exceed maximum bounds", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_comment_days: 4000 }), // max is 3650
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 CONFIRM_SHORTEN_REQUIRED when shortening noise retention window without confirmation", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 30 }), // current is 90
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe("CONFIRM_SHORTEN_REQUIRED");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns 400 CONFIRM_SHORTEN_REQUIRED when shortening comment retention window without confirmation", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_comment_days: 45 }), // current is 90
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("CONFIRM_SHORTEN_REQUIRED");
  });

  it("returns 400 CONFIRM_SHORTEN_REQUIRED when shortening evidence retention window without confirmation", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_evidence_days: 730 }), // current is 2555
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("CONFIRM_SHORTEN_REQUIRED");
  });

  it("does not ask for confirmShorten when RETENTION_REQUIRE_SHORTEN_CONFIRM is off (#637)", async () => {
    mockEnv.RETENTION_REQUIRE_SHORTEN_CONFIRM = false;
    try {
      const res = await makeApp().request(`/${TENANT_ID}/retention`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retention_days: 30 }), // current is 90
      });
      expect(res.status).toBe(200);
    } finally {
      mockEnv.RETENTION_REQUIRE_SHORTEN_CONFIRM = true;
    }
  });

  it("succeeds when shortening with confirmShorten: true", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 30, confirmShorten: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data).toEqual({
      tenantId: TENANT_ID,
      retention_days: 30,
      retention_comment_days: 90,
      retention_evidence_days: 2555,
      retention_hold: false,
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const auditArg = mockWriteAuditEntry.mock.calls[0][1];
    expect(auditArg).toMatchObject({
      tenantId: TENANT_ID,
      actorId: "u-superadmin",
      actorType: "user",
      resourceType: "tenant",
      resourceId: TENANT_ID,
      action: "updated",
      beforeSnapshot: { retention_days: 90, retention_hold: false },
      afterSnapshot: { retention_days: 30, retention_hold: false },
      metadata: { type: "retention_policy_update", confirmShorten: true },
    });
  });

  it("succeeds when widening retention without confirmShorten", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 180 }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data.retention_days).toBe(180);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const auditArg = mockWriteAuditEntry.mock.calls[0][1];
    expect(auditArg.metadata).toEqual({
      type: "retention_policy_update",
      confirmShorten: false,
    });
  });

  it("succeeds when setting retention_hold to true", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_hold: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data.retention_hold).toBe(true);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const auditArg = mockWriteAuditEntry.mock.calls[0][1];
    expect(auditArg.beforeSnapshot.retention_hold).toBe(false);
    expect(auditArg.afterSnapshot.retention_hold).toBe(true);
  });

  it("returns 404 when tenant does not exist in db", async () => {
    currentDbRows = [];
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 120 }),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("NOT_FOUND");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("returns 400 when confirmShorten is explicitly false", async () => {
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 30, confirmShorten: false }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("CONFIRM_SHORTEN_REQUIRED");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("preserves non-retention config keys (e.g. rate_limit_per_min) in tenants.config", async () => {
    fakeTenant.config = {
      rate_limit_per_min: 500,
      retention_days: 90,
      retention_comment_days: 90,
      retention_evidence_days: 2555,
      retention_hold: false,
    };
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: 120 }),
    });
    expect(res.status).toBe(200);
    expect(lastDbUpdateSet).toBeDefined();
    expect(lastDbUpdateSet?.config).toMatchObject({
      rate_limit_per_min: 500,
      retention_days: 120,
    });
  });

  it("succeeds when clearing retention_hold to false from true", async () => {
    fakeTenant.config = {
      retention_days: 90,
      retention_comment_days: 90,
      retention_evidence_days: 2555,
      retention_hold: true,
    };
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_hold: false }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data.retention_hold).toBe(false);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const auditArg = mockWriteAuditEntry.mock.calls[0][1];
    expect(auditArg.beforeSnapshot.retention_hold).toBe(true);
    expect(auditArg.afterSnapshot.retention_hold).toBe(false);
  });

  it("returns 404 before validation when non-platform caller sends an invalid body", async () => {
    mockEnv.PLATFORM_ORG_ID = "t-platform";
    mockAuth.tenantId = "t-customer";
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalidField: "bad" }),
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("NOT_FOUND");
  });

  it("succeeds when clearing an override with null (widening without confirmShorten)", async () => {
    fakeTenant.config = {
      retention_days: 30, // currently shorter than platform default (90)
      retention_comment_days: 90,
      retention_evidence_days: 2555,
      retention_hold: false,
    };
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: null }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    // Returns platform default (90)
    expect(json.data.retention_days).toBe(90);
    // Key should be deleted from config
    expect(lastDbUpdateSet?.config).not.toHaveProperty("retention_days");
  });

  it("requires confirmShorten when clearing an override with null results in shortening", async () => {
    fakeTenant.config = {
      retention_days: 180, // longer than platform default (90)
      retention_comment_days: 90,
      retention_evidence_days: 2555,
      retention_hold: false,
    };
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: null }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("CONFIRM_SHORTEN_REQUIRED");
  });

  it("succeeds when clearing an override with null when confirmShorten: true is provided", async () => {
    fakeTenant.config = {
      retention_days: 180,
      retention_comment_days: 90,
      retention_evidence_days: 2555,
      retention_hold: false,
    };
    const res = await makeApp().request(`/${TENANT_ID}/retention`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: null, confirmShorten: true }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data.retention_days).toBe(90);
    expect(lastDbUpdateSet?.config).not.toHaveProperty("retention_days");
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const auditArg = mockWriteAuditEntry.mock.calls[0][1];
    expect(auditArg.beforeSnapshot.retention_days).toBe(180);
    expect(auditArg.afterSnapshot.retention_days).toBe(90);
  });
});
