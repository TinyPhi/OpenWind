import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { AuthContext } from "./types.js";

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
    RATE_LIMIT_TENANT_PER_MIN: 100,
    RATE_LIMIT_API_KEY_PER_MIN: 200,
    RATE_LIMIT_API_KEY_PERSON_PER_MIN: 20,
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
const mockCheckRateLimit = vi.fn();
vi.mock("@platform/redis", () => ({
  getRedis: vi.fn(() => ({})),
  closeRedis: vi.fn(),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockArgon2Verify = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("@node-rs/argon2", () => ({
  verify: mockArgon2Verify,
  hash: vi.fn().mockResolvedValue("$argon2id$v=19$mock-hash"),
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

// Module-level db fallback for resolveTenantStatus (status), the new
// lookupTenantIdByOrgId (id), and lookupOrgIdByTenantId (zitadelOrgId) —
// all three go through db.select(...).from(tenants).where(...).limit(1),
// so one shared row shape covers all three callers.
// undefined = "no row" (org/tenant has no mapping).
let mockTenantRow:
  | { id?: string; status?: string; zitadelOrgId?: string | null }
  | undefined = {
  status: "active",
  zitadelOrgId: "org-ccc",
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
  mockTenantRow = { status: "active", zitadelOrgId: "org-ccc" };
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 99,
    resetAt: 0,
  });
  mockArgon2Verify.mockResolvedValue(true);
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
      select: mockModuleDbSelect,
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
    // module-level db (mockModuleDbSelect), already wired for "active" and "org-ccc".
    const fakeRow = {
      id: "key-id-1",
      tenant_id: "tenant-abc",
      scopes: ["read"],
    };
    const mockDb = {
      execute: vi.fn().mockResolvedValue([fakeRow]),
      select: mockModuleDbSelect,
    };

    const app = new Hono<{ Variables: { auth: AuthContext } }>();
    let authContext: AuthContext | undefined;
    app.get(
      "/test",
      requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      (c) => {
        authContext = c.get("auth");
        return c.json({ ok: true });
      },
    );

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer sk_validkey" },
    });
    expect(res.status).toBe(200);
    expect(authContext).toBeDefined();
    expect(authContext?.orgId).toBe("org-ccc");
  });

  describe("argon2id verification (#237)", () => {
    it("returns 401 when argon2 verification fails (tampered or wrong key)", async () => {
      const fakeRow = {
        id: "key-id-2",
        tenant_id: "tenant-abc",
        scopes: ["read"],
        key_hash_argon2: "$argon2id$v=19$stored-hash",
      };
      mockArgon2Verify.mockResolvedValueOnce(false);
      const mockDb = {
        execute: vi.fn().mockResolvedValue([fakeRow]),
        select: mockModuleDbSelect,
      };

      const app = makeApp([
        requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      ]);
      const res = await get(app, "sk_tamperedkey");
      expect(res.status).toBe(401);
    });

    it("passes without calling argon2 when key_hash_argon2 is null (legacy key)", async () => {
      const fakeRow = {
        id: "key-id-3",
        tenant_id: "tenant-abc",
        scopes: ["read"],
        key_hash_argon2: null,
      };
      const mockDb = {
        execute: vi.fn().mockResolvedValue([fakeRow]),
        select: mockModuleDbSelect,
      };

      const app = makeApp([
        requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      ]);
      const res = await get(app, "sk_legacykey");
      expect(res.status).toBe(200);
      expect(mockArgon2Verify).not.toHaveBeenCalled();
    });

    it("uses cached argon2 result on repeated requests — calls argon2 only once", async () => {
      const fakeRow = {
        id: "key-id-4",
        tenant_id: "tenant-abc",
        scopes: ["read"],
        key_hash_argon2: "$argon2id$v=19$stored-hash",
      };
      const mockDb = {
        execute: vi.fn().mockResolvedValue([fakeRow]),
        select: mockModuleDbSelect,
      };

      const app = makeApp([
        requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      ]);
      // Two requests with the same raw key — second should hit the in-process cache.
      await get(app, "sk_cachetestkey");
      await get(app, "sk_cachetestkey");
      expect(mockArgon2Verify).toHaveBeenCalledTimes(1);
    });
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

      // Exposes the resolved auth context so the assertion below can confirm
      // tenantId was actually remapped to the mocked tenant row's uuid, not
      // just that the request happened to return 200.
      const app = new Hono();
      app.get("/test", requireAuth(), (c) => c.json(c.get("auth")));
      const res = await get(app, "valid.jwt");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { tenantId: string };
      expect(body.tenantId).toBe("mapped-tenant-uuid");
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

  // #195: unlike the pre-auth IP-based stage, this check runs only after the
  // token/key has been verified, so it keys on the real, unforgeable tenantId.
  describe("post-auth tenant-scoped rate limit (#195)", () => {
    it("keys the check on the verified tenantId for the JWT path", async () => {
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);

      const app = makeApp([requireAuth()]);
      await get(app, "valid.jwt");

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        `rl:tenant:${VALID_AUTH.tenantId}`,
        100,
        60,
      );
    });

    it("returns 429 when the tenant has exceeded its quota (JWT path)", async () => {
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);
      mockCheckRateLimit.mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: 123,
      });

      const app = makeApp([requireAuth()]);
      const res = await get(app, "valid.jwt");

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("RATE_LIMITED");
    });

    it("keys the check on the verified tenantId for the API-key path", async () => {
      const fakeRow = {
        id: "key-id-1",
        tenant_id: "tenant-abc",
        scopes: ["read"],
      };
      const mockDb = {
        execute: vi.fn().mockResolvedValue([fakeRow]),
        select: mockModuleDbSelect,
      };

      const app = makeApp([
        requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      ]);
      await get(app, "sk_validkey");

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        "rl:tenant:tenant-abc",
        100,
        60,
      );
    });

    it("returns 429 when the tenant has exceeded its quota (API-key path)", async () => {
      const fakeRow = {
        id: "key-id-1",
        tenant_id: "tenant-abc",
        scopes: ["read"],
      };
      const mockDb = {
        execute: vi.fn().mockResolvedValue([fakeRow]),
        select: mockModuleDbSelect,
      };
      mockCheckRateLimit.mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: 123,
      });

      const app = makeApp([
        requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      ]);
      const res = await get(app, "sk_validkey");

      expect(res.status).toBe(429);
    });

    it("fails open (200) when the rate-limit check itself throws", async () => {
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);
      mockCheckRateLimit.mockRejectedValueOnce(new Error("redis down"));

      const app = makeApp([requireAuth()]);
      const res = await get(app, "valid.jwt");

      expect(res.status).toBe(200);
    });

    it("a forged/varied unverified claim cannot create a fresh bucket — key depends only on the verified tenantId", async () => {
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);
      const app1 = makeApp([requireAuth()]);
      await get(app1, "valid.jwt");

      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);
      const app2 = makeApp([requireAuth()]);
      await get(app2, "valid.jwt");

      const keys = mockCheckRateLimit.mock.calls.map((c) => c[1] as string);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).toBe(`rl:tenant:${VALID_AUTH.tenantId}`);
    });
  });

  describe("post-auth per-api-key aggregate rate limit (ADR-012 Phase G, ADR-013)", () => {
    it("keys the check on the api_keys row id, in addition to the tenant tier", async () => {
      const fakeRow = {
        id: "key-id-1",
        tenant_id: "tenant-abc",
        scopes: ["read"],
      };
      const mockDb = {
        execute: vi.fn().mockResolvedValue([fakeRow]),
        select: mockModuleDbSelect,
      };

      const app = makeApp([
        requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      ]);
      await get(app, "sk_validkey");

      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        "rl:api-key:key-id-1",
        200,
        60,
      );
    });

    it("returns 429 when the key's own aggregate quota is exceeded, even though the tenant tier passed", async () => {
      const fakeRow = {
        id: "key-id-1",
        tenant_id: "tenant-abc",
        scopes: ["read"],
      };
      const mockDb = {
        execute: vi.fn().mockResolvedValue([fakeRow]),
        select: mockModuleDbSelect,
      };
      // 1st call = tenant tier (allowed), 2nd call = api-key tier (denied)
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, remaining: 50, resetAt: 1 })
        .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: 123 });

      const app = makeApp([
        requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      ]);
      const res = await get(app, "sk_validkey");

      expect(res.status).toBe(429);
    });

    it("does not run for the JWT path (no api_keys row involved)", async () => {
      mockVerifyJwt.mockResolvedValueOnce({ sub: "user-123" });
      mockExtractAuthContext.mockReturnValueOnce(VALID_AUTH);

      const app = makeApp([requireAuth()]);
      await get(app, "valid.jwt");

      const keys = mockCheckRateLimit.mock.calls.map((c) => c[1] as string);
      expect(keys.some((k) => k.startsWith("rl:api-key:"))).toBe(false);
    });

    it("fails open (200) when the api-key-tier check itself throws", async () => {
      const fakeRow = {
        id: "key-id-1",
        tenant_id: "tenant-abc",
        scopes: ["read"],
      };
      const mockDb = {
        execute: vi.fn().mockResolvedValue([fakeRow]),
        select: mockModuleDbSelect,
      };
      mockCheckRateLimit
        .mockResolvedValueOnce({ allowed: true, remaining: 50, resetAt: 1 })
        .mockRejectedValueOnce(new Error("redis down"));

      const app = makeApp([
        requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
      ]);
      const res = await get(app, "sk_validkey");

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
      select: mockModuleDbSelect,
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

// ── fetchUserInfo caching (#16) ────────────────────────────────────────────────

describe("fetchUserInfo caching", () => {
  // email falsy or displayName === userId is the condition that triggers
  // enrichment (see requireAuth's `!auth.email || auth.displayName === auth.userId`).
  const NEEDS_ENRICHMENT_AUTH = {
    userId: "user-999",
    tenantId: "tenant-abc",
    roles: ["agent"],
    email: "",
    displayName: "user-999",
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ name: "Real Name", email: "real@example.com" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the userinfo endpoint once and reuses the cached result for a second request with the same token", async () => {
    mockVerifyJwt.mockResolvedValue({ sub: "user-999" });
    mockExtractAuthContext.mockReturnValue(NEEDS_ENRICHMENT_AUTH);

    const app = makeApp([requireAuth()]);
    const res1 = await get(app, "same-token");
    const res2 = await get(app, "same-token");

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls the userinfo endpoint again for a different token", async () => {
    mockVerifyJwt.mockResolvedValue({ sub: "user-999" });
    mockExtractAuthContext.mockReturnValue(NEEDS_ENRICHMENT_AUTH);

    const app = makeApp([requireAuth()]);
    await get(app, "token-a");
    await get(app, "token-b");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedups concurrent requests for the same token into a single userinfo call", async () => {
    mockVerifyJwt.mockResolvedValue({ sub: "user-999" });
    mockExtractAuthContext.mockReturnValue(NEEDS_ENRICHMENT_AUTH);

    const app = makeApp([requireAuth()]);
    const [res1, res2, res3] = await Promise.all([
      get(app, "concurrent-token"),
      get(app, "concurrent-token"),
      get(app, "concurrent-token"),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
