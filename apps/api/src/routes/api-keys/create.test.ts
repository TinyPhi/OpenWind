import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";
import type * as PlatformAuth from "@platform/auth";

// ── Hoisted mutable auth fixture ──────────────────────────────────────────────

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    tenantId: "t-aaa",
    userId: "u-bbb",
    roles: ["admin"] as string[],
    email: "test@example.com",
  },
}));

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@platform/auth", async () => {
  // detectScopesFormat is pure and has no side effects worth mocking — use the
  // real implementation so this test's insertArg.scopesFormat assertions stay
  // meaningful instead of hardcoding a duplicate copy of its logic here.
  const actual = await vi.importActual<typeof PlatformAuth>("@platform/auth");
  return {
    requireAuth:
      () =>
      async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
        c.set("auth", mockAuth as AuthContext);
        await next();
      },
    requireRole:
      (..._roles: string[]) =>
      async (_c: Context, next: Next) => {
        await next();
      },
    requireIntrospection: () => async (_c: Context, next: Next) => {
      await next();
    },
    hashApiKey: (key: string) => `sha256:${key}`,
    hashApiKeyArgon2: async (key: string) => `argon2id:${key}`,
    API_KEY_DEFAULT_TTL_DAYS: 365,
    detectScopesFormat: actual.detectScopesFormat,
  };
});

const mockInsertValues = vi.fn();
const mockWriteAuditEntry = vi.fn();

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      insert: () => tx,
      values: (...args: unknown[]) => {
        mockInsertValues(...args);
        return tx;
      },
      returning: () =>
        Promise.resolve([
          {
            id: "key-1",
            name: "test-key",
            scopes: [],
            scopesFormat: "role",
            createdAt: new Date(),
            expiresAt: new Date("2027-08-09T00:00:00Z"),
          },
        ]),
    };
    return fn(tx);
  },
  apiKeys: {},
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => {
    mockWriteAuditEntry(...args);
    return Promise.resolve();
  },
}));

const { createApiKeyHandler } = await import("./create.js");

// ── Test app ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/", ...createApiKeyHandler);
  return app;
}

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ name: "my-key", ...overrides });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api-keys — scope ceiling guard (#223)", () => {
  beforeEach(() => {
    mockAuth.roles = ["admin"];
  });

  it("returns 201 when scopes match creator role exactly", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["admin"] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 201 when admin grants a lower-privilege scope (hierarchy check)", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["agent"] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 403 when agent attempts to grant admin scope — escalation blocked", async () => {
    mockAuth.roles = ["agent"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["admin"] }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 403 for an unknown scope string", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["custom_role"] }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 for empty scopes array", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: [] }),
    });
    expect(res.status).toBe(201);
  });

  it("returns 201 for default (no scopes field)", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });
    expect(res.status).toBe(201);
  });

  it("returns 403 when admin requests superadmin scope — privilege escalation blocked", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["superadmin"] }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("FORBIDDEN");
  });

  it("returns 403 when admin requests a mix containing superadmin", async () => {
    mockAuth.roles = ["admin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["admin", "superadmin"] }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 201 when superadmin requests superadmin scope", async () => {
    mockAuth.roles = ["superadmin"];
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["superadmin"] }),
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /api-keys — argon2id hash storage (#237)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
  });

  it("returns 201 and stores both SHA-256 and argon2id hashes", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });

    expect(res.status).toBe(201);
    expect(mockInsertValues).toHaveBeenCalledOnce();

    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.keyHash).toMatch(/^sha256:/);
    expect(insertArg.keyHashArgon2).toMatch(/^argon2id:/);
  });

  it("raw key is returned in the response body exactly once", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });

    const json = await res.json();
    expect(json.data.key).toMatch(/^sk_live_/);
    expect(json.data.keyHash).toBeUndefined();
    expect(json.data.keyHashArgon2).toBeUndefined();
  });
});

describe("POST /api-keys — lifecycle hardening (ADR-008 Decision #2/#3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
  });

  it("stamps created_by with the caller's userId and sets a non-null expiresAt", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });

    expect(res.status).toBe(201);
    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.createdBy).toBe(mockAuth.userId);
    expect(insertArg.expiresAt).toBeInstanceOf(Date);
  });

  // Review finding (PR #373, L3): create.ts stamps scopesFormat on every
  // insert (ADR-008 Decision #6) — no prior assertion covered it.
  it("stamps scopesFormat on the insert and returns it in the response body", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ scopes: ["agent"] }),
    });

    expect(res.status).toBe(201);
    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.scopesFormat).toBe("role");

    const json = await res.json();
    expect(json.data.scopesFormat).toBe("role");
  });

  it("writes an audit entry for the new key (previously wrote none at all)", async () => {
    await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body({ name: "ci-key", scopes: ["agent"] }),
    });

    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const entry = mockWriteAuditEntry.mock.calls[0][1];
    expect(entry.action).toBe("created");
    expect(entry.resourceType).toBe("api_key");
    expect(entry.actorId).toBe(mockAuth.userId);
    expect(entry.resourceId).toBe("key-1");
  });

  it("returns expiresAt in the response body", async () => {
    const res = await makeApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body(),
    });

    const json = await res.json();
    expect(json.data.expiresAt).toBeDefined();
  });
});
