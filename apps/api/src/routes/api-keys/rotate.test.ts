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
  ne: vi.fn((...args: unknown[]) => ({ op: "ne", args })),
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
      {
        id: "orig-1",
        name: "ci-key",
        scopes: ["admin"],
        scopesFormat: "role",
        expiresAt: null,
      },
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
      {
        id: "orig-1",
        name: "ci-key",
        scopes: ["admin"],
        scopesFormat: "role",
        expiresAt: null,
      },
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

describe("POST /api-keys/:id/rotate — third-party (action-scoped) keys (ADR-012 Phase A, PR A3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["agent"]; // deliberately NOT admin — must not matter for action-format
    mockOriginalRows = [
      {
        id: "orig-1",
        name: "third-party-key",
        scopes: ["entity:ticket:read"],
        scopesFormat: "action",
        expiresAt: null,
        rotatedFrom: null,
        applicationName: "Acme Helpdesk Sync",
        applicationDescription: null,
        applicationContactEmail: "ops@acme.example",
        zitadelClientId: "acme-helpdesk-sync-client",
      },
    ];
    mockInsertReturns = [
      {
        id: "key-2",
        name: "third-party-key",
        scopes: ["entity:ticket:read"],
        scopesFormat: "action",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        applicationName: "Acme Helpdesk Sync",
        zitadelClientId: "acme-helpdesk-sync-client",
      },
    ];
  });

  it("rotates successfully regardless of the caller's roles — the ceiling check does not apply to action-format keys", async () => {
    const res = await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(res.status).toBe(201);
  });

  it("carries the application record and Client ID forward onto the successor", async () => {
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.applicationName).toBe("Acme Helpdesk Sync");
    expect(insertArg.zitadelClientId).toBe("acme-helpdesk-sync-client");
  });

  it("stamps a 3-month expiry on the successor, not the internal-key default TTL", async () => {
    const before = Date.now();
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    const insertArg = mockInsertValues.mock.calls[0][0];
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const expiresAt = (insertArg.expiresAt as Date).getTime();
    expect(expiresAt).toBeGreaterThan(before + ninetyDaysMs - 5000);
    expect(expiresAt).toBeLessThan(before + ninetyDaysMs + 5000);
  });

  it("hands off the Client ID's uniqueness claim by setting the predecessor's zitadelClientIdActive to false", async () => {
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    // calls[0] is the pre-existing expiresAt-shortening update (position
    // preserved for the existing role-format test suite above).
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg.zitadelClientIdActive).toBe(false);
  });
});

describe("POST /api-keys/:id/rotate — lineage cap (ADR-012 Phase A spec R4, PR A3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
  });

  it("instantly kills a still-live predecessor when rotating a key that itself has one", async () => {
    mockOriginalRows = [
      {
        id: "middle-key",
        name: "ci-key",
        scopes: ["agent"],
        scopesFormat: "role",
        expiresAt: null,
        rotatedFrom: "old-predecessor",
      },
    ];
    await makeApp().request("/middle-key/rotate", { method: "POST" });
    // calls[1] is the new lineage-cleanup update (position 1, after the
    // pre-existing expiresAt-shortening update at position 0).
    const setArg = mockUpdateSet.mock.calls[1][0];
    expect(setArg.revokedAt).toBeInstanceOf(Date);
    expect(setArg.revokedBy).toBe("system:rotation-lineage-cap");
  });

  it("still issues the lineage-cleanup update even when there is no stale predecessor/successor to clean up", async () => {
    mockOriginalRows = [
      {
        id: "orig-1",
        name: "ci-key",
        scopes: ["agent"],
        scopesFormat: "role",
        expiresAt: null,
        rotatedFrom: null,
      },
    ];
    await makeApp().request("/orig-1/rotate", { method: "POST" });
    expect(mockUpdateSet).toHaveBeenCalledTimes(2);
  });

  // Regression test: the lineage-cleanup query's WHERE clause excluded
  // original.id but not the just-inserted successor's own id — and since
  // every successor's rotatedFrom always equals original.id by construction,
  // the query caught and instantly revoked the key it had just created, on
  // every single rotation (found via manual testing against real Postgres:
  // two consecutive rotates both self-revoked their own new key within
  // milliseconds). This asserts the WHERE clause excludes BOTH ids, not just
  // original's — the mocked drizzle-orm ne() calls are inspectable by their
  // recorded args since the real query builder isn't actually evaluated here.
  it("excludes both original.id AND the newly-created successor's own id from the lineage-cleanup query — a fresh rotate must never self-revoke its own result", async () => {
    mockOriginalRows = [
      {
        id: "orig-1",
        name: "ci-key",
        scopes: ["agent"],
        scopesFormat: "role",
        expiresAt: null,
        rotatedFrom: null,
      },
    ];
    const res = await makeApp().request("/orig-1/rotate", { method: "POST" });
    const json = (await res.json()) as { data: { id: string } };
    const createdId = json.data.id;

    const [andCall] = mockUpdateWhere.mock.calls[1] as [
      { op: string; args: Array<{ op: string; args: unknown[] }> },
    ];
    expect(andCall.op).toBe("and");
    const neCalls = andCall.args.filter((a) => a.op === "ne");
    const excludedIds = neCalls.map((c) => c.args[1]);
    expect(excludedIds).toContain("orig-1");
    expect(excludedIds).toContain(createdId);
  });
});
