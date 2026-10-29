import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as Auth from "@platform/auth";
import type { AuthContext } from "@platform/auth";

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
          roles: ["user"],
          email: "test@example.com",
        });
        await next();
      },
  };
});

const mockRows = vi.fn();
const mockWhere = vi.fn((_condition: unknown) => ({
  limit: () => mockRows(),
}));
const mockWithTenantContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ select: () => ({ from: () => ({ where: mockWhere }) }) }),
);
vi.mock("@platform/db", () => ({
  tenants: { id: "id", name: "name", logo: "logo", isSandbox: "isSandbox" },
  withTenantContext: (...args: unknown[]) =>
    mockWithTenantContext(
      ...(args as Parameters<typeof mockWithTenantContext>),
    ),
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ["eq", a, b],
}));

const { getOrgBrandingHandler } = await import("./org.js");

function get(): Promise<Response> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.get("/me/org", ...getOrgBrandingHandler);
  return Promise.resolve(app.request("/me/org"));
}

describe("GET /me/org", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the name and logo of a sandbox tenant, nothing else", async () => {
    mockRows.mockResolvedValue([
      {
        name: "Acme Demo",
        logo: "data:image/png;base64,AAAA",
        isSandbox: true,
      },
    ]);

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { name: "Acme Demo", logo: "data:image/png;base64,AAAA" },
    });
  });

  it("returns null for a tenant that is not a sandbox, whatever its name", async () => {
    mockRows.mockResolvedValue([
      { name: "Real Customer", logo: null, isSandbox: false },
    ]);

    const res = await get();

    expect(await res.json()).toEqual({ data: null });
  });

  it("returns null when the tenant row is missing", async () => {
    mockRows.mockResolvedValue([]);

    expect(await (await get()).json()).toEqual({ data: null });
  });

  it("lets only the caller's own browser cache the answer, for five minutes", async () => {
    mockRows.mockResolvedValue([
      { name: "Acme Demo", logo: null, isSandbox: true },
    ]);

    const res = await get();

    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
  });

  it("sends the same cache header for a tenant that is not a sandbox", async () => {
    mockRows.mockResolvedValue([
      { name: "Real Customer", logo: null, isSandbox: false },
    ]);

    const res = await get();

    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
  });

  it("looks up only the caller's own tenant", async () => {
    mockRows.mockResolvedValue([]);

    await get();

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      "t-aaa",
      expect.any(Function),
    );
    expect(mockWhere).toHaveBeenCalledWith(["eq", "id", "t-aaa"]);
  });
});
