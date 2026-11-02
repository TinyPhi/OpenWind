import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type * as DrizzleOrm from "drizzle-orm";

const mockRows = vi.fn();
const mockWhere = vi.fn((_condition: unknown) => ({ limit: () => mockRows() }));
const mockSelect = vi.fn((_columns: unknown) => ({
  from: () => ({ where: mockWhere }),
}));
vi.mock("@platform/db", () => ({
  db: { select: (columns: unknown) => mockSelect(columns) },
  tenants: {
    loginKey: "loginKey",
    isSandbox: "isSandbox",
    status: "status",
    name: "name",
    logo: "logo",
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return {
    ...actual,
    eq: (a: unknown, b: unknown) => ["eq", a, b],
    and: (...args: unknown[]) => ["and", ...args],
  };
});

const mockEnforce = vi.fn();
vi.mock("../../lib/rate-limit-tiers.js", () => ({
  enforcePublicBrandingRateLimit: (...args: unknown[]) => mockEnforce(...args),
}));

vi.mock("../../middleware/rate-limit.js", () => ({
  rateLimitKey: () => "203.0.113.7",
}));

const { getOrgBrandingByKeyHandler } = await import("./org-branding.js");

const KEY = "3f9a1c7e2b4d8a60";

function get(key: string): Promise<Response> {
  const app = new Hono();
  app.get("/org-branding/:key", ...getOrgBrandingByKeyHandler);
  return Promise.resolve(app.request(`/org-branding/${key}`));
}

const MISS_BODY = { error: "NOT_FOUND", message: "Not found" };

beforeEach(() => {
  vi.clearAllMocks();
  mockEnforce.mockResolvedValue({ allowed: true, remaining: 29, resetAt: 0 });
});

describe("GET /public/org-branding/:key", () => {
  it("returns exactly name and logo for an active sandbox, cacheable for a minute", async () => {
    mockRows.mockResolvedValue([
      { name: "Acme Demo", logo: "data:image/png;base64,AAAA" },
    ]);

    const res = await get(KEY);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(await res.json()).toEqual({
      data: { name: "Acme Demo", logo: "data:image/png;base64,AAAA" },
    });
  });

  it("selects only the name and logo columns, so nothing else can reach the response", async () => {
    mockRows.mockResolvedValue([{ name: "Acme Demo", logo: null }]);

    await get(KEY);

    expect(mockSelect).toHaveBeenCalledWith({ name: "name", logo: "logo" });
  });

  it("matches on the login key, and only an active sandbox is ever answered", async () => {
    mockRows.mockResolvedValue([]);

    await get(KEY);

    expect(mockWhere).toHaveBeenCalledWith([
      "and",
      ["eq", "loginKey", KEY],
      ["eq", "isSandbox", true],
      ["eq", "status", "active"],
    ]);
  });

  it("answers an unknown key with the shared 404, never cached", async () => {
    mockRows.mockResolvedValue([]);

    const res = await get("0000000000000000");

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual(MISS_BODY);
  });

  it.each([
    ["uppercase hex", "3F9A1C7E2B4D8A60"],
    ["one character short", "3f9a1c7e2b4d8a6"],
    ["one character long", "3f9a1c7e2b4d8a601"],
    ["a non-hex letter", "3f9a1c7e2b4d8a6g"],
    ["a readable slug", "acme-demo-4821"],
    ["a dash", "3f9a1c7e-b4d8a60"],
    ["a dot", "3f9a1c7e.b4d8a60"],
    ["encoded markup", "%3Cscript%3E"],
    ["a quote", "3f9a1c7e'b4d8a60"],
    ["a very long value", "a".repeat(200)],
  ])(
    "refuses %s with the same 404 and never reads the database",
    async (_label, key) => {
      const res = await get(key);

      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual(MISS_BODY);
      expect(mockSelect).not.toHaveBeenCalled();
    },
  );

  it("gives a malformed key the byte-identical body of an unknown one", async () => {
    mockRows.mockResolvedValue([]);

    const unknown = await (await get("0000000000000000")).text();
    const malformed = await (await get("Not_A_Key")).text();

    expect(malformed).toBe(unknown);
  });

  it("answers 429 uncached and reads nothing when the limit is spent", async () => {
    mockEnforce.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 1 });

    const res = await get(KEY);

    expect(res.status).toBe(429);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("limits by the client address, before it looks at the key", async () => {
    await get("Not_A_Key");

    expect(mockEnforce).toHaveBeenCalledWith("203.0.113.7");
  });

  it("never puts the key back in the answer", async () => {
    mockRows.mockResolvedValue([{ name: "Acme Demo", logo: null }]);

    const text = await (await get(KEY)).text();

    expect(text).not.toContain(KEY);
  });

  it("needs no sign-in", async () => {
    mockRows.mockResolvedValue([{ name: "Acme Demo", logo: null }]);

    const res = await get(KEY);

    expect(res.status).toBe(200);
  });
});
