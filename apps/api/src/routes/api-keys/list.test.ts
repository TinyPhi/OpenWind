import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AuthContext } from "@platform/auth";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSelectRows: unknown[] = [];

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
      c.set("auth", {
        tenantId: "t-aaa",
        userId: "u-bbb",
        roles: ["admin"],
        email: "test@example.com",
      });
      await next();
    },
  requireRole: () => async (_c: Context, next: Next) => {
    await next();
  },
  requireIntrospection: () => async (_c: Context, next: Next) => {
    await next();
  },
}));

const mockWhere = vi.fn();

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => tx,
      from: () => tx,
      where: (...args: unknown[]) => {
        mockWhere(...args);
        return tx;
      },
      orderBy: () => tx,
      limit: () => tx,
      offset: () => Promise.resolve(mockSelectRows),
    };
    return fn(tx);
  },
  apiKeys: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: "eq", args })),
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  isNull: vi.fn((...args: unknown[]) => ({ op: "isNull", args })),
  desc: vi.fn((...args: unknown[]) => ({ op: "desc", args })),
}));

const { listApiKeysHandler } = await import("./list.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/", ...listApiKeysHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api-keys — pagination (#261)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectRows.length = 0;
  });

  it("returns 200 with default limit=100 offset=0 when no query params", async () => {
    const res = await makeApp().request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveProperty("data");
  });

  it("accepts valid limit and offset params", async () => {
    const res = await makeApp().request("/?limit=25&offset=50");
    expect(res.status).toBe(200);
  });

  it("rejects limit above 500 with 400", async () => {
    const res = await makeApp().request("/?limit=501");
    expect(res.status).toBe(400);
  });

  it("rejects limit=0 with 400", async () => {
    const res = await makeApp().request("/?limit=0");
    expect(res.status).toBe(400);
  });

  it("rejects negative offset with 400", async () => {
    const res = await makeApp().request("/?offset=-1");
    expect(res.status).toBe(400);
  });
});

describe("GET /api-keys — excludes revoked keys (ADR-008 Decision #4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectRows.length = 0;
  });

  it("filters on tenantId AND revokedAt IS NULL", async () => {
    const res = await makeApp().request("/");
    expect(res.status).toBe(200);
    expect(mockWhere).toHaveBeenCalledOnce();
    const [andCall] = mockWhere.mock.calls[0];
    expect(andCall.op).toBe("and");
    expect(andCall.args.some((a: { op: string }) => a.op === "isNull")).toBe(
      true,
    );
  });

  it("surfaces createdBy and expiresAt for each row", async () => {
    mockSelectRows.push({
      id: "key-1",
      name: "test",
      scopes: [],
      scopesFormat: "role",
      lastUsedAt: null,
      createdAt: new Date(),
      createdBy: "u-bbb",
      expiresAt: new Date("2027-08-09T00:00:00Z"),
    });
    const res = await makeApp().request("/");
    const json = await res.json();
    expect(json.data[0].createdBy).toBe("u-bbb");
    expect(json.data[0].expiresAt).toBeDefined();
  });

  // Review finding (PR #373, L4): list.ts now selects scopesFormat alongside
  // scopes (ADR-008 Decision #6) — no prior assertion covered it.
  it("surfaces scopesFormat for each row", async () => {
    mockSelectRows.push({
      id: "key-1",
      name: "test",
      scopes: ["agent"],
      scopesFormat: "role",
      lastUsedAt: null,
      createdAt: new Date(),
      createdBy: "u-bbb",
      expiresAt: new Date("2027-08-09T00:00:00Z"),
    });
    const res = await makeApp().request("/");
    const json = await res.json();
    expect(json.data[0].scopesFormat).toBe("role");
  });
});

describe("GET /api-keys — includeRevoked opt-in (ADR-012 Phase A, PR A5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectRows.length = 0;
  });

  it("still filters on tenantId AND revokedAt IS NULL when includeRevoked is omitted — ADR-008 Decision #4's default is unchanged", async () => {
    const res = await makeApp().request("/");
    expect(res.status).toBe(200);
    const [andCall] = mockWhere.mock.calls[0];
    expect(andCall.op).toBe("and");
    expect(andCall.args.some((a: { op: string }) => a.op === "isNull")).toBe(
      true,
    );
  });

  it("filters on tenantId only (no revokedAt exclusion) when includeRevoked=true", async () => {
    const res = await makeApp().request("/?includeRevoked=true");
    expect(res.status).toBe(200);
    const [eqCall] = mockWhere.mock.calls[0];
    expect(eqCall.op).toBe("eq");
  });

  it("surfaces applicationName, rotatedFrom, and revokedAt for each row", async () => {
    mockSelectRows.push({
      id: "key-1",
      name: "third-party-key",
      scopes: ["entity:ticket:read"],
      scopesFormat: "action",
      applicationName: "Acme Helpdesk Sync",
      rotatedFrom: "key-0",
      lastUsedAt: null,
      createdAt: new Date(),
      createdBy: "u-bbb",
      expiresAt: new Date("2027-08-09T00:00:00Z"),
      revokedAt: null,
    });
    const res = await makeApp().request("/?includeRevoked=true");
    const json = await res.json();
    expect(json.data[0].applicationName).toBe("Acme Helpdesk Sync");
    expect(json.data[0].rotatedFrom).toBe("key-0");
    expect(json.data[0].revokedAt).toBeNull();
  });

  it("surfaces applicationDescription and applicationContactEmail so the UI can pre-fill an edit form (PR A5 AC7)", async () => {
    mockSelectRows.push({
      id: "key-1",
      name: "third-party-key",
      scopes: ["entity:ticket:read"],
      scopesFormat: "action",
      applicationName: "Acme Helpdesk Sync",
      applicationDescription: "Syncs tickets nightly",
      applicationContactEmail: "ops@acme.example",
      rotatedFrom: null,
      lastUsedAt: null,
      createdAt: new Date(),
      createdBy: "u-bbb",
      expiresAt: new Date("2027-08-09T00:00:00Z"),
      revokedAt: null,
    });
    const res = await makeApp().request("/?includeRevoked=true");
    const json = await res.json();
    expect(json.data[0].applicationDescription).toBe("Syncs tickets nightly");
    expect(json.data[0].applicationContactEmail).toBe("ops@acme.example");
  });
});
