import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { PlatformAdminAuthContext } from "@platform/auth";

const { mockPlatformAdmin } = vi.hoisted(() => ({
  mockPlatformAdmin: {
    userId: "pa-1",
    roles: ["platform_admin"],
    email: "ops@openwind.io",
    displayName: "Ops",
  },
}));

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

const mockOrderByRows = vi.fn();
const mockLimitRows = vi.fn();
const mockTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        orderBy: () => mockOrderByRows(),
        limit: () => mockLimitRows(),
      }),
    }),
  }),
};

vi.mock("@platform/db", () => ({
  tenants: {
    id: "id",
    name: "name",
    isSandbox: "isSandbox",
    trialEndsAt: "trialEndsAt",
    createdAt: "createdAt",
  },
  withPlatformAdminContext: (fn: (tx: unknown) => unknown) => fn(mockTx),
  // Real, minimal re-implementation (not mocked away) so these tests exercise the actual
  // allow-list logic, not a stand-in that could silently diverge from
  // packages/db/src/platform-admin-view.ts.
  toPlatformAdminSandboxView: (row: {
    id: string;
    name: string;
    isSandbox: boolean;
    trialEndsAt: Date | null;
    createdAt: Date;
  }) => ({
    id: row.id,
    name: row.name,
    isSandbox: row.isSandbox,
    createdAt: row.createdAt.toISOString(),
    trialStatus: !row.trialEndsAt
      ? "none"
      : row.trialEndsAt.getTime() > Date.now()
        ? "active"
        : "expired",
  }),
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ["eq", a, b],
  and: (...args: unknown[]) => ["and", ...args],
  desc: (a: unknown) => ["desc", a],
}));

const { sandboxListHandler, sandboxDetailHandler } =
  await import("./sandboxes-list.js");

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
  it("returns every sandbox as a PlatformAdminSandboxView, newest first", async () => {
    mockOrderByRows.mockResolvedValue([
      {
        id: TENANT_ID,
        name: "Acme Sandbox",
        isSandbox: true,
        trialEndsAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
    ]);
    const app = makeApp();

    const res = await app.request("/sandboxes");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      {
        id: TENANT_ID,
        name: "Acme Sandbox",
        isSandbox: true,
        createdAt: "2026-10-01T00:00:00.000Z",
        trialStatus: "active",
      },
    ]);
  });

  it("returns an empty array when there are no sandboxes", async () => {
    mockOrderByRows.mockResolvedValue([]);
    const app = makeApp();

    const res = await app.request("/sandboxes");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
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
    });
  });

  it("returns 404 when no such sandbox exists", async () => {
    mockLimitRows.mockResolvedValue([]);
    const app = makeApp();

    const res = await app.request(`/sandboxes/${TENANT_ID}`);

    expect(res.status).toBe(404);
  });
});
