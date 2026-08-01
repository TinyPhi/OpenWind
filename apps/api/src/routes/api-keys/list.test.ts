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

vi.mock("@platform/db", () => ({
  withTenantContext: (_tenantId: unknown, fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => tx,
      from: () => tx,
      where: () => tx,
      orderBy: () => tx,
      limit: () => tx,
      offset: () => Promise.resolve(mockSelectRows),
    };
    return fn(tx);
  },
  apiKeys: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
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
