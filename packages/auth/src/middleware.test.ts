import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mutable so individual tests can exercise the NODE_ENV=production branch
// (org-id -> tenant mapping) without affecting the rest of the suite.
let mockNodeEnv: string | undefined;
vi.mock("@platform/config", () => ({
  env: {
    ZITADEL_ISSUER: "https://zitadel.example.com",
    ZITADEL_AUDIENCE: "platform-api",
    ZITADEL_INTROSPECTION_URL:
      "https://zitadel.example.com/oauth/v2/introspect",
    ZITADEL_INTROSPECTION_CLIENT_ID: "client-id",
    ZITADEL_INTROSPECTION_CLIENT_SECRET: "client-secret",
    get NODE_ENV() {
      return mockNodeEnv;
    },
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// middleware.ts -> tenant-status-cache.ts -> @platform/redis, whose module
// scope does `import { env } from "@platform/config"` — that real import
// isn't covered by the "@platform/config" mock above (pnpm workspace
// resolution loads it as a separate module instance), so it fails Zod
// validation against an empty test env before any test runs. Stub it out;
// this suite only exercises the in-memory getCachedTenantStatus path.
vi.mock("@platform/redis", () => ({
  getRedis: vi.fn(),
  closeRedis: vi.fn(),
}));

const mockVerifyJwt = vi.fn();
const mockExtractAuthContext = vi.fn();
vi.mock("./jwks.js", () => ({
  verifyJwt: (...args: unknown[]) => mockVerifyJwt(...args),
  extractAuthContext: (...args: unknown[]) => mockExtractAuthContext(...args),
}));

const mockIntrospectToken = vi.fn();
vi.mock("./introspection.js", () => ({
  introspectToken: (...args: unknown[]) => mockIntrospectToken(...args),
}));

// Module-level db fallback for both resolveTenantStatus (status) and the new
// lookupTenantIdByOrgId (id) — both go through db.select(...).from(tenants)
// .where(...).limit(1), so one shared row shape covers either caller.
// undefined = "no row" (org has no mapped tenant / tenant not found).
let mockTenantRow: { id?: string; status?: string } | undefined = {
  status: "active",
};
const mockModuleDbSelect = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({
      limit: vi.fn(() => Promise.resolve(mockTenantRow ? [mockTenantRow] : [])),
    })),
  })),
}));

// Row tenant_users would return for the current test's SELECT-before-write
// check (#124). Set per-test; undefined means "no existing row" (new user).
let mockExistingTenantUser:
  | { email: string | null; displayName: string | null }
  | undefined;

const mockTxInsertValues = vi.fn();
const mockTxOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);

vi.mock("@platform/db", () => ({
  apiKeys: {
    id: "api_keys.id",
    tenantId: "api_keys.tenant_id",
    keyHash: "api_keys.key_hash",
    scopes: "api_keys.scopes",
  },
  tenants: {
    id: "tenants.id",
    status: "tenants.status",
    zitadelOrgId: "tenants.zitadel_org_id",
  },
  tenantUsers: {
    tenantId: "tenant_users.tenant_id",
    userId: "tenant_users.user_id",
    email: "tenant_users.email",
    displayName: "tenant_users.display_name",
  },
  db: { select: mockModuleDbSelect },
  // withTenantContext is called (awaited, not fire-and-forget) after JWT
  // auth; mock it to run the callback against a fake tx that mimics the
  // #124 select-then-conditionally-write flow.
  withTenantContext: vi.fn((_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi
              .fn()
              .mockResolvedValue(
                mockExistingTenantUser ? [mockExistingTenantUser] : [],
              ),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: (v: unknown) => {
          mockTxInsertValues(v);
          return { onConflictDoUpdate: mockTxOnConflictDoUpdate };
        },
      })),
      // Used by resolveApiKey's last_used_at write once the tenant is known.
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    }),
  ),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  and: vi.fn((...conds) => ({ op: "and", conds })),
  sql: (...args: unknown[]) => ({ sql: args }),
}));

const { requireAuth, requireRole, requireIntrospection } =
  await import("./middleware.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_AUTH = {
  userId: "user-123",
  tenantId: "tenant-abc",
  roles: ["agent"],
  email: "alice@example.com",
};

function makeApp(handlers: Parameters<Hono["get"]>[1][]) {
  const app = new Hono();
  app.get("/test", ...handlers, (c) => c.json({ ok: true }));
  return app;
}

async function get(app: Hono, token?: string) {
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};
  return app.request("/test", { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistingTenantUser = undefined;
  mockNodeEnv = undefined;
  mockTenantRow = { status: "active" };
});

// ── requireAuth ───────────────────────────────────────────────────────────────

describe("requireAuth", () => {
  it("returns 401 when Authorization header is absent", async () => {
    const app = makeApp([requireAuth()]);
    const res = await get(app);
    expect(res.status).toBe(401);
  });

  it("returns 401 when JWT verification fails", async () => {
    mockVerifyJwt.mockResolvedValueOnce(null);
    const app = makeApp([requireAuth()]);
    const res = await get(app, "bad.jwt.token");
    expect(res.status).toBe(401);
  });

  it("returns 401 when claims extraction returns null (missing required claims)", async () => {
    mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
    mockExtractAuthContext.mockReturnValueOnce(null);
    const app = makeApp([requireAuth()]);
    const res = await get(app, "some.jwt");
    expect(res.status).toBe(401);
  });

  it("sets auth context and calls next when JWT is valid", async () => {
    mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
    mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);

    const app = makeApp([requireAuth()]);
    const res = await get(app, "valid.jwt");

    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({ ok: true });
  });

  // #124: the tenant_users sync must not write on every request — only
  // insert for a brand-new user, or update when the synced fields drift.
  describe("tenant_users sync (#124)", () => {
    it("inserts the row when no tenant_user exists yet (new user)", async () => {
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);
      mockExistingTenantUser = undefined;

      const app = makeApp([requireAuth()]);
      const res = await get(app, "valid.jwt");

      expect(res.status).toBe(200);
      expect(mockTxInsertValues).toHaveBeenCalledTimes(1);
      expect(mockTxOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    });

    it("skips the write when the existing row already matches the JWT profile", async () => {
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);
      mockExistingTenantUser = {
        email: VALID_AUTH.email,
        displayName: null,
      };

      const app = makeApp([requireAuth()]);
      const res = await get(app, "valid.jwt");

      expect(res.status).toBe(200);
      expect(mockTxInsertValues).not.toHaveBeenCalled();
      expect(mockTxOnConflictDoUpdate).not.toHaveBeenCalled();
    });

    it("writes the update when the existing row's profile has drifted", async () => {
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);
      mockExistingTenantUser = {
        email: "stale@example.com",
        displayName: null,
      };

      const app = makeApp([requireAuth()]);
      const res = await get(app, "valid.jwt");

      expect(res.status).toBe(200);
      expect(mockTxInsertValues).toHaveBeenCalledTimes(1);
      expect(mockTxInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ email: VALID_AUTH.email }),
      );
      expect(mockTxOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("returns 401 when API key is not found in db", async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue([]),
    };

    const app = makeApp([
      requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
    ]);
    const res = await get(app, "sk_unknownkey");
    expect(res.status).toBe(401);
  });

  it("resolves auth from API key when key matches db row", async () => {
    // (#124-adjacent) resolveApiKey now looks the key up via the
    // resolve_api_key_by_hash SECURITY DEFINER function (execute), not a
    // plain select, since api_keys' RLS policy can't be satisfied before the
    // tenant is known. resolveTenantStatus's select still goes through the
    // module-level db (mockModuleDbSelect), already wired for "active".
    const fakeRow = {
      id: "key-id-1",
      tenant_id: "tenant-abc",
      scopes: ["read"],
    };
    const mockDb = {
      execute: vi.fn().mockResolvedValue([fakeRow]),
    };

    const app = makeApp([
      requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
    ]);
    const res = await get(app, "sk_validkey");
    expect(res.status).toBe(200);
  });

  // Zitadel org ids are never valid `uuid`s, so in production the JWT path
  // must resolve the real tenant via the zitadel_org_id mapping rather than
  // pass the org id straight through as tenantId. See
  // docs/specs/tenant-org-id-mapping.md.
  describe("production tenant resolution (org-id mapping)", () => {
    it("resolves tenantId from the mapped tenant when NODE_ENV=production", async () => {
      mockNodeEnv = "production";
      mockTenantRow = { id: "mapped-tenant-uuid", status: "active" };
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce({
        ...VALID_AUTH,
        tenantId: "378675861571829762", // raw org id, not a uuid
        orgId: "378675861571829762",
      });

      const app = makeApp([requireAuth()]);
      const res = await get(app, "valid.jwt");

      expect(res.status).toBe(200);
    });

    it("rejects with 404 when the org has no mapped tenant", async () => {
      mockNodeEnv = "production";
      mockTenantRow = undefined; // no tenant row matches this org
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce({
        ...VALID_AUTH,
        tenantId: "999999999999999999",
        orgId: "999999999999999999",
      });

      const app = makeApp([requireAuth()]);
      const res = await get(app, "valid.jwt");

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("TENANT_NOT_FOUND");
    });

    it("leaves tenantId untouched when NODE_ENV is not production", async () => {
      mockNodeEnv = "test";
      mockTenantRow = undefined; // would 404 if the lookup ran at all
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce({
        ...VALID_AUTH,
        orgId: "378675861571829762",
      });

      const app = makeApp([requireAuth()]);
      const res = await get(app, "valid.jwt");

      // Unaffected by mockTenantRow being unset — the org-lookup branch
      // must not run outside production.
      expect(res.status).toBe(200);
    });
  });
});

// ── requireRole ───────────────────────────────────────────────────────────────

describe("requireRole", () => {
  function makeAuthApp(...roles: string[]) {
    const app = new Hono();
    app.get("/test", requireAuth(), requireRole(...roles), (c) =>
      c.json({ ok: true }),
    );
    return app;
  }

  it("returns 403 when actor does not have required role", async () => {
    mockVerifyJwt.mockResolvedValueOnce({});
    mockExtractAuthContext.mockReturnValueOnce({
      ...VALID_AUTH,
      roles: ["agent"],
    });

    const app = makeAuthApp("admin");
    const res = await get(app, "jwt");
    expect(res.status).toBe(403);
  });

  it("allows request when actor has one of the required roles", async () => {
    mockVerifyJwt.mockResolvedValueOnce({});
    mockExtractAuthContext.mockReturnValueOnce({
      ...VALID_AUTH,
      roles: ["agent", "admin"],
    });

    const app = makeAuthApp("admin");
    const res = await get(app, "jwt");
    expect(res.status).toBe(200);
  });
});

// ── requireIntrospection ──────────────────────────────────────────────────────

describe("requireIntrospection", () => {
  function makeIntrospectApp() {
    const app = new Hono();
    app.get("/test", requireAuth(), requireIntrospection(), (c) =>
      c.json({ ok: true }),
    );
    return app;
  }

  it("returns 401 when introspection reports token inactive", async () => {
    mockVerifyJwt.mockResolvedValueOnce({});
    mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);
    mockIntrospectToken.mockResolvedValueOnce({ active: false });

    const app = makeIntrospectApp();
    const res = await get(app, "some.jwt");
    expect(res.status).toBe(401);
  });

  it("allows request when introspection reports token active", async () => {
    mockVerifyJwt.mockResolvedValueOnce({});
    mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);
    mockIntrospectToken.mockResolvedValueOnce({ active: true });

    const app = makeIntrospectApp();
    const res = await get(app, "some.jwt");
    expect(res.status).toBe(200);
  });

  it("skips introspection for API keys (sk_ prefix)", async () => {
    const fakeRow = {
      id: "key-id-1",
      tenant_id: "tenant-abc",
      scopes: ["read"],
    };
    const mockDb = {
      execute: vi.fn().mockResolvedValue([fakeRow]),
    };

    const app = new Hono();
    app.get(
      "/test",
      requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      requireIntrospection(),
      (c) => c.json({ ok: true }),
    );

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer sk_validkey" },
    });

    // introspectToken should NOT have been called
    expect(mockIntrospectToken).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
