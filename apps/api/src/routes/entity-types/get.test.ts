import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as Auth from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetEntityType = vi.fn();

const mockWithTenantContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) => fn({}),
);

vi.mock("@platform/auth", async (importOriginal) => {
  const real = await importOriginal<typeof Auth>();
  return {
    ...real,
    requireAuth:
      () =>
      async (c: Context<{ Variables: { auth: AuthContext } }>, next: Next) => {
        c.set("auth", {
          tenantId: "t-aaa",
          userId: "u-bbb",
          roles: ["agent"],
          email: "test@example.com",
        });
        await next();
      },
  };
});

vi.mock("@platform/db", () => ({
  withTenantContext: (...args: unknown[]) =>
    mockWithTenantContext(
      ...(args as Parameters<typeof mockWithTenantContext>),
    ),
}));

vi.mock("@platform/entity-engine", async (importOriginal) => {
  const real = await importOriginal<typeof EntityEngine>();
  return {
    ...real,
    getEntityType: (...args: unknown[]) => mockGetEntityType(...args),
  };
});

const { getEntityTypeHandler } = await import("./get.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/entity-types/:id", ...getEntityTypeHandler);
  return app;
}

const fakeEntityType = {
  id: "00000000-0000-0000-0000-000000000001",
  tenantId: "t-aaa",
  name: "ticket",
  plural: "Tickets",
  icon: null,
  moduleId: null,
  allowCustomFields: true,
  createdAt: new Date("2026-01-01"),
};

describe("GET /entity-types/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with entity type data", async () => {
    mockGetEntityType.mockResolvedValue(fakeEntityType);

    const res = await makeApp().request(
      "/entity-types/00000000-0000-0000-0000-000000000001",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ name: "ticket" });
  });

  it("routes the DB query through withTenantContext scoped to the auth tenantId (#234)", async () => {
    mockGetEntityType.mockResolvedValue(fakeEntityType);

    await makeApp().request(
      "/entity-types/00000000-0000-0000-0000-000000000001",
    );

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      "t-aaa",
      expect.any(Function),
    );
  });
});
