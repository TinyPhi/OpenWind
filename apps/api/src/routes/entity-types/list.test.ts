import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as Auth from "@platform/auth";
import type { AuthContext } from "@platform/auth";
import type * as EntityEngine from "@platform/entity-engine";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockListEntityTypes = vi.fn();

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
    listEntityTypes: (...args: unknown[]) => mockListEntityTypes(...args),
    MAX_PAGE_SIZE: 100,
  };
});

const { listEntityTypesHandler } = await import("./list.js");

function makeApp() {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/entity-types", ...listEntityTypesHandler);
  return app;
}

const fakePage = {
  items: [{ id: "00000000-0000-0000-0000-000000000001", name: "ticket" }],
  nextCursor: null,
};

describe("GET /entity-types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with paginated entity types", async () => {
    mockListEntityTypes.mockResolvedValue(fakePage);

    const res = await makeApp().request("/entity-types");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
  });

  it("routes the DB query through withTenantContext scoped to the auth tenantId (#234)", async () => {
    mockListEntityTypes.mockResolvedValue(fakePage);

    await makeApp().request("/entity-types");

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      "t-aaa",
      expect.any(Function),
    );
  });
});
