import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

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

const mockHashApiKeyArgon2 = vi.fn(async (key: string) => `argon2id:${key}`);

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
  hashApiKey: (key: string) => `sha256:${key}`,
  hashApiKeyArgon2: (key: string) => mockHashApiKeyArgon2(key),
  API_KEY_DEFAULT_TTL_DAYS: 365,
  API_KEY_ROTATION_OVERLAP_HOURS: 24,
}));

let mockOriginalRows: unknown[] = [
  {
    id: "orig-1",
    name: "ci-key",
    scopes: ["agent"],
    scopesFormat: "role",
    expiresAt: null,
  },
];
let mockInsertReturns: unknown[] = [
  {
    id: "key-2",
    name: "ci-key",
    scopes: ["agent"],
    scopesFormat: "role",
    createdAt: new Date(),
    expiresAt: new Date("2027-08-09T00:00:00Z"),
  },
];
const mockInsertValues = vi.fn();
const mockUpdateSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockWriteAuditEntry = vi.fn();

vi.mock("@platform/db", () => ({
  withTenantContext: (
    _tenantId: unknown,
    fn: (tx: unknown) => unknown,
  ): unknown => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(mockOriginalRows),
          }),
        }),
      }),
      insert: () => ({
        values: (...args: unknown[]) => {
          mockInsertValues(...args);
          return { returning: () => Promise.resolve(mockInsertReturns) };
        },
      }),
      update: () => ({
        set: (...args: unknown[]) => {
          mockUpdateSet(...args);
          return {
            where: (...whereArgs: unknown[]) => {
              mockUpdateWhere(...whereArgs);
              return Promise.resolve();
            },
          };
        },
      }),
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

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  or: vi.fn((...args: unknown[]) => ({ op: "or", args })),
  isNull: vi.fn((...args: unknown[]) => ({ op: "isNull", args })),
  gt: vi.fn((...args: unknown[]) => ({ op: "gt", args })),
}));

const { rotateApiKeyHandler } = await import("./rotate.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/rotate", ...rotateApiKeyHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api-keys/:id/rotate (ADR-008 Decision #3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
    mockOriginalRows = [
      {
        id: "orig-1",
        name: "ci-key",
        scopes: ["agent"],
        scopesFormat: "role",
        expiresAt: null,
      },
    ];
    mockInsertReturns = [
      {
        id: "key-2",
        name: "ci-key",
        scopes: ["agent"],
        scopesFormat: "role",
        createdAt: new Date(),
        expiresAt: new Date("2027-08-09T00:00:00Z"),
      },
    ];
  });

  it("returns 404 when the key doesn't exist or is already revoked", async () => {
    mockOriginalRows = [];
    const res = await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller's roles no longer cover the original key's scopes", async () => {
    mockAuth.roles = ["user"];
    mockOriginalRows = [
      { id: "orig-1", name: "ci-key", scopes: ["admin"], expiresAt: null },
    ];
    const res = await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(res.status).toBe(403);
  });

  // Review finding (PR #361): hashApiKeyArgon2 is intentionally slow
  // (~100-250ms) and must not run for a request that's going to be rejected
  // anyway — moved to after the eligibility/scope checks.
  it("does not run argon2id hashing when the key is not found", async () => {
    mockOriginalRows = [];
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(mockHashApiKeyArgon2).not.toHaveBeenCalled();
  });

  it("does not run argon2id hashing when the scope ceiling check fails", async () => {
    mockAuth.roles = ["user"];
    mockOriginalRows = [
      { id: "orig-1", name: "ci-key", scopes: ["admin"], expiresAt: null },
    ];
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(mockHashApiKeyArgon2).not.toHaveBeenCalled();
  });

  it("runs argon2id hashing exactly once for an eligible rotation", async () => {
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(mockHashApiKeyArgon2).toHaveBeenCalledOnce();
  });

  it("mints a replacement inheriting the original's name/scopes, with rotatedFrom set", async () => {
    const res = await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(res.status).toBe(201);

    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.name).toBe("ci-key");
    expect(insertArg.scopes).toEqual(["agent"]);
    expect(insertArg.rotatedFrom).toBe("orig-1");
    expect(insertArg.createdBy).toBe(mockAuth.userId);
    expect(insertArg.expiresAt).toBeInstanceOf(Date);
  });

  // Review finding (PR #373, M3): scopesFormat is carried forward from the
  // original key, not recomputed — this is a real insert-path change with no
  // prior coverage.
  it("carries the original key's scopesFormat forward unchanged, not recomputed", async () => {
    mockOriginalRows = [
      {
        id: "orig-1",
        name: "ci-key",
        scopes: ["agent"],
        scopesFormat: "role",
        expiresAt: null,
      },
    ];
    const res = await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(res.status).toBe(201);

    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.scopesFormat).toBe("role");

    const json = await res.json();
    expect(json.data.scopesFormat).toBe("role");
  });

  // Review finding (PR #361): the overlap-window UPDATE was missing an
  // explicit tenantId filter (Security Rule #1 requires it alongside RLS,
  // even though original.id already came from a tenant-scoped SELECT).
  it("filters the overlap-window update on both id and tenantId", async () => {
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    const whereArg = mockUpdateWhere.mock.calls[0][0] as {
      op: string;
      args: { op: string; args: unknown[] }[];
    };
    expect(whereArg.op).toBe("and");
    expect(whereArg.args).toHaveLength(2);
    expect(whereArg.args.map((a) => a.args[1])).toEqual(
      expect.arrayContaining(["orig-1", mockAuth.tenantId]),
    );
  });

  it("pulls the original key's expiresAt forward to the overlap window instead of revoking it immediately", async () => {
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg.expiresAt).toBeInstanceOf(Date);
    // Overlap window (24h) must be far shorter than the new key's full TTL (365d)
    const hoursFromNow =
      (setArg.expiresAt.getTime() - Date.now()) / (60 * 60 * 1000);
    expect(hoursFromNow).toBeLessThan(25);
    expect(hoursFromNow).toBeGreaterThan(0);
  });

  it("keeps the original's already-sooner expiresAt instead of extending it to the overlap window (security review finding)", async () => {
    // Original expires in 2 hours — shorter than the 24h overlap window.
    // Rotation must NOT push this out to 24h; that would resurrect a
    // soon-to-die credential instead of only ever shortening its life.
    const soonerExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000);
    mockOriginalRows = [
      {
        id: "orig-1",
        name: "ci-key",
        scopes: ["agent"],
        expiresAt: soonerExpiry,
      },
    ];
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg.expiresAt.getTime()).toBe(soonerExpiry.getTime());
  });

  it("pulls a later expiresAt in to the overlap window (still shortening)", async () => {
    // Original expires in 10 days — later than the 24h overlap window.
    mockOriginalRows = [
      {
        id: "orig-1",
        name: "ci-key",
        scopes: ["agent"],
        expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      },
    ];
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    const setArg = mockUpdateSet.mock.calls[0][0];
    const hoursFromNow =
      (setArg.expiresAt.getTime() - Date.now()) / (60 * 60 * 1000);
    expect(hoursFromNow).toBeLessThan(25);
  });

  it("writes an audit entry recording the rotation lineage", async () => {
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(mockWriteAuditEntry).toHaveBeenCalledOnce();
    const entry = mockWriteAuditEntry.mock.calls[0][1];
    expect(entry.action).toBe("created");
    expect(entry.resourceType).toBe("api_key");
    expect(entry.metadata).toEqual({ rotatedFrom: "orig-1" });
  });

  it("returns the raw replacement key exactly once in the response", async () => {
    const res = await makeApp().request("/orig-1/rotate", { method: "POST" });
    const json = await res.json();
    expect(json.data.key).toMatch(/^sk_live_/);
  });
});
