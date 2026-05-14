import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@platform/config", () => ({
  env: {
    ZITADEL_ISSUER: "https://zitadel.example.com",
    ZITADEL_AUDIENCE: "platform-api",
    ZITADEL_INTROSPECTION_URL:
      "https://zitadel.example.com/oauth/v2/introspect",
    ZITADEL_INTROSPECTION_CLIENT_ID: "client-id",
    ZITADEL_INTROSPECTION_CLIENT_SECRET: "client-secret",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

vi.mock("@platform/db", () => ({
  apiKeys: "api_keys_mock",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
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

  it("returns 401 when API key is not found in db", async () => {
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };

    const app = makeApp([
      requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
    ]);
    const res = await get(app, "sk_unknownkey");
    expect(res.status).toBe(401);
  });

  it("resolves auth from API key when key matches db row", async () => {
    const fakeRow = {
      id: "key-id-1",
      tenantId: "tenant-abc",
      scopes: ["read"],
    };
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([fakeRow]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    };

    const app = makeApp([
      requireAuth(mockDb as unknown as Parameters<typeof requireAuth>[0]),
    ]);
    const res = await get(app, "sk_validkey");
    expect(res.status).toBe(200);
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
      tenantId: "tenant-abc",
      scopes: ["read"],
    };
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([fakeRow]),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
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
