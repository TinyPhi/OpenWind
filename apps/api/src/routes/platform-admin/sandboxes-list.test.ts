import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { PlatformAdminAuthContext } from "@platform/auth";
import type * as PlatformDb from "@platform/db";
import type * as DrizzleOrm from "drizzle-orm";

const { mockPlatformAdmin, mockLimitRows, mockWhere, mockOrderBy, mockTx } =
  vi.hoisted(() => {
    const mockLimitRows = vi.fn();
    const mockWhere = vi.fn();
    const mockOrderBy = vi.fn();
    const mockTx = {
      select: () => ({
        from: () => ({
          where: (cond: unknown) => {
            mockWhere(cond);
            return {
              orderBy: (...columns: unknown[]) => {
                mockOrderBy(...columns);
                return { limit: (n: number) => mockLimitRows(n) };
              },
              limit: (n: number) => mockLimitRows(n),
            };
          },
        }),
      }),
    };
    return {
      mockPlatformAdmin: {
        userId: "pa-1",
        roles: ["platform_admin"],
        email: "ops@openwind.io",
        displayName: "Ops",
      },
      mockLimitRows,
      mockWhere,
      mockOrderBy,
      mockTx,
    };
  });

vi.mock("@platform/auth", () => ({
  requirePlatformAdmin:
    () =>
    async (
      c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
      next: Next,
    ) => {
      c.set("platformAdmin", mockPlatformAdmin as PlatformAdminAuthContext);
      await next();
    },
}));

vi.mock("@platform/db", async (importOriginal) => {
  const actual = await importOriginal<typeof PlatformDb>();
  return {
    ...actual,
    withPlatformAdminContext: (fn: (tx: unknown) => unknown) => fn(mockTx),
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return {
    ...actual,
    eq: (a: unknown, b: unknown) => ["eq", a, b],
    and: (...args: unknown[]) => ["and", ...args],
    inArray: (a: unknown, b: unknown) => ["inArray", a, b],
    desc: (a: unknown) => ["desc", a],
  };
});

const { sandboxListHandler, sandboxDetailHandler } =
  await import("./sandboxes-list.js");
const { tenants } = await import("@platform/db");

function makeApp() {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.get("/sandboxes", ...sandboxListHandler);
  app.get("/sandboxes/:tenantId", ...sandboxDetailHandler);
  return app;
}

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /sandboxes", () => {
  it("lists only active or suspended sandboxes, so deleted ones drop out", async () => {
    mockLimitRows.mockResolvedValue([]);

    await makeApp().request("/sandboxes");

    expect(mockWhere).toHaveBeenCalledWith([
      "and",
      ["eq", tenants.isSandbox, true],
      ["inArray", tenants.status, ["active", "suspended"]],
    ]);
  });

  it("returns every sandbox as a PlatformAdminSandboxView, newest first, with hasMore false by default", async () => {
    const trialEndsAt = new Date(Date.now() + 86_400_000);
    mockLimitRows.mockResolvedValue([
      {
        id: TENANT_ID,
        name: "Acme Sandbox",
        isSandbox: true,
        trialEndsAt,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
    ]);
    const app = makeApp();

    const res = await app.request("/sandboxes");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasMore).toBe(false);
    expect(body.data).toEqual([
      {
        id: TENANT_ID,
        name: "Acme Sandbox",
        isSandbox: true,
        createdAt: "2026-10-01T00:00:00.000Z",
        trialStatus: "active",
        trialEndsAt: trialEndsAt.toISOString(),
      },
    ]);
    // Default limit is 100, so limit + 1 = 101 rows requested
    expect(mockLimitRows).toHaveBeenCalledWith(101);
  });

  it("orders newest first, with the id as a tiebreaker so the order is stable (#992)", async () => {
    mockLimitRows.mockResolvedValue([]);

    await makeApp().request("/sandboxes");

    expect(mockOrderBy).toHaveBeenCalledWith(
      ["desc", tenants.createdAt],
      ["desc", tenants.id],
    );
  });

  it("returns hasMore true and slices data when more rows than limit exist (#845)", async () => {
    mockLimitRows.mockResolvedValue([
      {
        id: "tenant-1",
        name: "Sandbox 1",
        isSandbox: true,
        trialEndsAt: null,
        createdAt: new Date("2026-10-02T00:00:00Z"),
      },
      {
        id: "tenant-2",
        name: "Sandbox 2",
        isSandbox: true,
        trialEndsAt: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
      {
        id: "tenant-3",
        name: "Sandbox 3",
        isSandbox: true,
        trialEndsAt: null,
        createdAt: new Date("2026-09-30T00:00:00Z"),
      },
    ]);
    const app = makeApp();

    const res = await app.request("/sandboxes?limit=2");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockLimitRows).toHaveBeenCalledWith(3);
    expect(body.hasMore).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("tenant-1");
    expect(body.data[1].id).toBe("tenant-2");
  });

  it("returns 400 when limit is invalid (< 1 or > 500) (#845)", async () => {
    const app = makeApp();

    const resZero = await app.request("/sandboxes?limit=0");
    expect(resZero.status).toBe(400);

    const resNegative = await app.request("/sandboxes?limit=-5");
    expect(resNegative.status).toBe(400);

    const resTooLarge = await app.request("/sandboxes?limit=501");
    expect(resTooLarge.status).toBe(400);

    const resNaN = await app.request("/sandboxes?limit=invalid");
    expect(resNaN.status).toBe(400);
  });

  it("returns an empty array when there are no sandboxes", async () => {
    mockLimitRows.mockResolvedValue([]);
    const app = makeApp();

    const res = await app.request("/sandboxes");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.hasMore).toBe(false);
  });
});

describe("GET /sandboxes/:tenantId", () => {
  it("returns a single sandbox's view", async () => {
    mockLimitRows.mockResolvedValue([
      {
        id: TENANT_ID,
        name: "Acme Sandbox",
        isSandbox: true,
        trialEndsAt: null,
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
    ]);
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      id: TENANT_ID,
      name: "Acme Sandbox",
      isSandbox: true,
      createdAt: "2026-10-01T00:00:00.000Z",
      trialStatus: "none",
      trialEndsAt: null,
    });
  });

  it("returns 404 when no such sandbox exists", async () => {
    mockLimitRows.mockResolvedValue([]);
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}`);

    expect(res.status).toBe(404);
  });
});
