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
}));

let mockTargetRows: unknown[] = [
  {
    id: "target-1",
    name: "ci-key",
    scopes: ["agent"],
    scopesFormat: "role",
  },
];
let mockLiveSuccessorRows: unknown[] = [];
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

// The handler issues two selects in sequence (target, then live successor) —
// a call counter picks which canned rows to return for which one, since both
// go through the same select()/from()/where()/limit() chain shape.
let selectCallCount = 0;

vi.mock("@platform/db", () => ({
  withTenantContext: (
    _tenantId: unknown,
    fn: (tx: unknown) => unknown,
  ): unknown => {
    selectCallCount = 0;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              selectCallCount += 1;
              return Promise.resolve(
                selectCallCount === 1 ? mockTargetRows : mockLiveSuccessorRows,
              );
            },
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

const { emergencyRotateApiKeyHandler } = await import("./emergency-rotate.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/:id/emergency-rotate", ...emergencyRotateApiKeyHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api-keys/:id/emergency-rotate (ADR-012 Phase A spec R5, PR A3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["admin"];
    mockTargetRows = [
      {
        id: "target-1",
        name: "ci-key",
        scopes: ["agent"],
        scopesFormat: "role",
      },
    ];
    mockLiveSuccessorRows = [];
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

  it("returns 404 when the target key doesn't exist or is already revoked", async () => {
    mockTargetRows = [];
    const res = await makeApp().request("/target-1/emergency-rotate", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller's roles no longer cover the target key's scopes (role-format only)", async () => {
    mockAuth.roles = ["user"];
    mockTargetRows = [
      {
        id: "target-1",
        name: "ci-key",
        scopes: ["admin"],
        scopesFormat: "role",
      },
    ];
    const res = await makeApp().request("/target-1/emergency-rotate", {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  it("kills the target instantly — revokedAt set, not just a shortened expiresAt", async () => {
    await makeApp().request("/target-1/emergency-rotate", { method: "POST" });
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg.revokedAt).toBeInstanceOf(Date);
    expect(setArg.revokedBy).toBe(mockAuth.userId);
  });

  it("issues a fresh replacement key with rotatedFrom pointing at the target", async () => {
    const res = await makeApp().request("/target-1/emergency-rotate", {
      method: "POST",
    });
    expect(res.status).toBe(201);
    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.rotatedFrom).toBe("target-1");
  });

  it("returns the raw replacement key exactly once", async () => {
    const res = await makeApp().request("/target-1/emergency-rotate", {
      method: "POST",
    });
    const json = await res.json();
    expect(json.data.key).toMatch(/^sk_live_/);
  });

  it("does not touch a successor when none exists", async () => {
    mockLiveSuccessorRows = [];
    await makeApp().request("/target-1/emergency-rotate", { method: "POST" });
    // Exactly one update: the target's own instant kill.
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
  });

  it("also kills a live successor instantly when the target has one (spec R5)", async () => {
    mockLiveSuccessorRows = [{ id: "successor-1" }];
    await makeApp().request("/target-1/emergency-rotate", { method: "POST" });
    expect(mockUpdateSet).toHaveBeenCalledTimes(2);
    const secondSetArg = mockUpdateSet.mock.calls[1][0];
    expect(secondSetArg.revokedAt).toBeInstanceOf(Date);
    expect(secondSetArg.revokedBy).toBe(mockAuth.userId);
  });

  it("records the successor kill in the target's audit entry metadata", async () => {
    mockLiveSuccessorRows = [{ id: "successor-1" }];
    await makeApp().request("/target-1/emergency-rotate", { method: "POST" });
    const targetAuditEntry = mockWriteAuditEntry.mock.calls[0][1];
    expect(targetAuditEntry.action).toBe("deleted");
    expect(targetAuditEntry.metadata.emergencyRotate).toBe(true);
    expect(targetAuditEntry.metadata.liveSuccessorAlsoKilled).toBe(
      "successor-1",
    );
  });

  it("writes a second audit entry for the newly created replacement key", async () => {
    await makeApp().request("/target-1/emergency-rotate", { method: "POST" });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(2);
    const createdAuditEntry = mockWriteAuditEntry.mock.calls[1][1];
    expect(createdAuditEntry.action).toBe("created");
    expect(createdAuditEntry.resourceId).toBe("key-2");
    expect(createdAuditEntry.metadata.emergencyRotatedFrom).toBe("target-1");
  });
});

describe("POST /api-keys/:id/emergency-rotate — third-party (action-scoped) keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.roles = ["agent"]; // must not matter for action-format
    mockTargetRows = [
      {
        id: "target-1",
        name: "third-party-key",
        scopes: ["entity:ticket:read"],
        scopesFormat: "action",
        applicationName: "Acme Helpdesk Sync",
        applicationDescription: null,
        applicationContactEmail: "ops@acme.example",
        oidcClientId: "acme-helpdesk-sync-client",
      },
    ];
    mockLiveSuccessorRows = [];
    mockInsertReturns = [
      {
        id: "key-2",
        name: "third-party-key",
        scopes: ["entity:ticket:read"],
        scopesFormat: "action",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        applicationName: "Acme Helpdesk Sync",
        oidcClientId: "acme-helpdesk-sync-client",
      },
    ];
  });

  it("succeeds regardless of the caller's roles — no ceiling check for action-format keys", async () => {
    const res = await makeApp().request("/target-1/emergency-rotate", {
      method: "POST",
    });
    expect(res.status).toBe(201);
  });

  it("carries the application record and Client ID forward onto the replacement", async () => {
    await makeApp().request("/target-1/emergency-rotate", { method: "POST" });
    const insertArg = mockInsertValues.mock.calls[0][0];
    expect(insertArg.applicationName).toBe("Acme Helpdesk Sync");
    expect(insertArg.oidcClientId).toBe("acme-helpdesk-sync-client");
  });

  it("stamps a 3-month expiry, not the internal-key default TTL", async () => {
    const before = Date.now();
    await makeApp().request("/target-1/emergency-rotate", { method: "POST" });
    const insertArg = mockInsertValues.mock.calls[0][0];
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const expiresAt = (insertArg.expiresAt as Date).getTime();
    expect(expiresAt).toBeGreaterThan(before + ninetyDaysMs - 5000);
    expect(expiresAt).toBeLessThan(before + ninetyDaysMs + 5000);
  });
});
