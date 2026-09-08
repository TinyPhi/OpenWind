import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { rateLimit } from "./rate-limit.js";

let mockTrustProxy = "true";
vi.mock("@platform/config", () => ({
  env: {
    get TRUST_PROXY() {
      return mockTrustProxy;
    },
  },
}));

let mockRemoteAddress: string | undefined = undefined;
vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn(() => ({
    remote: {
      address: mockRemoteAddress,
    },
  })),
}));

const mockCheckRateLimit = vi.fn();

vi.mock("@platform/redis", () => ({
  getRedis: vi.fn(() => ({})),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

function makeApp() {
  const app = new Hono();
  app.use("*", rateLimit());
  app.get("/entities", (c) => c.json({ data: [] }));
  app.get("/api-keys", (c) => c.json({ data: [] }));
  return app;
}

// A JWT-shaped (but unsigned/unverified) bearer token carrying an arbitrary
// org claim, so tests can prove the pre-auth stage never reads it.
function forgedBearer(org: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({ "urn:zitadel:iam:user:resourceowner:id": org }),
  ).toString("base64url");
  return `${header}.${payload}.`;
}

beforeEach(() => {
  mockTrustProxy = "true";
  mockRemoteAddress = undefined;
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 499,
    resetAt: 0,
  });
});

describe("rateLimit — pre-auth IP-only keying (#195)", () => {
  it("keys on client IP, ignoring any bearer token content", async () => {
    await makeApp().request("/entities", {
      headers: {
        "x-forwarded-for": "1.2.3.4",
        Authorization: `Bearer ${forgedBearer("org-a")}`,
      },
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:ip:1.2.3.4:api",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("two requests with different forged org claims from the same IP share one bucket", async () => {
    await makeApp().request("/entities", {
      headers: {
        "x-forwarded-for": "1.2.3.4",
        Authorization: `Bearer ${forgedBearer("org-a")}`,
      },
    });
    await makeApp().request("/entities", {
      headers: {
        "x-forwarded-for": "1.2.3.4",
        Authorization: `Bearer ${forgedBearer("org-b")}`,
      },
    });

    const keys = mockCheckRateLimit.mock.calls.map((c) => c[1] as string);
    expect(keys[0]).toBe(keys[1]);
  });

  it("different client IPs get independent buckets", async () => {
    await makeApp().request("/entities", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    await makeApp().request("/entities", {
      headers: { "x-forwarded-for": "5.6.7.8" },
    });

    const keys = mockCheckRateLimit.mock.calls.map((c) => c[1] as string);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("prioritizes x-real-ip over x-forwarded-for when both are present (#540)", async () => {
    await makeApp().request("/entities", {
      headers: {
        "x-real-ip": "9.8.7.6",
        "x-forwarded-for": "1.2.3.4, 10.0.0.5",
      },
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:ip:9.8.7.6:api",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("takes only the first hop of a chained x-forwarded-for header when x-real-ip is absent", async () => {
    await makeApp().request("/entities", {
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.5, 10.0.0.6" },
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:ip:1.2.3.4:api",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("uses x-real-ip when x-forwarded-for is absent", async () => {
    await makeApp().request("/entities", {
      headers: { "x-real-ip": "9.8.7.6" },
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:ip:9.8.7.6:api",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("falls back to 'unknown' when no IP header is present", async () => {
    await makeApp().request("/entities");
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:ip:unknown:api",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("applies the tighter auth-route limit and key class for /api-keys", async () => {
    await makeApp().request("/api-keys", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:ip:1.2.3.4:auth",
      10,
      expect.any(Number),
    );
  });

  it("returns 429 with the standard error body when the limit is exceeded", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: 123,
    });
    const res = await makeApp().request("/entities", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json).toEqual({
      error: "RATE_LIMITED",
      message: "Too many requests",
    });
  });

  it("sets x-ratelimit-* response headers", async () => {
    const res = await makeApp().request("/entities", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(res.headers.get("x-ratelimit-limit")).toBe("500");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("499");
  });

  it("ignores x-real-ip and x-forwarded-for when TRUST_PROXY is false, falling back to peer IP", async () => {
    mockTrustProxy = "false";
    mockRemoteAddress = "192.168.1.100";

    await makeApp().request("/entities", {
      headers: {
        "x-real-ip": "1.2.3.4",
        "x-forwarded-for": "5.6.7.8",
      },
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:ip:192.168.1.100:api",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("allows proxy headers when TRUST_PROXY matches connecting peer CIDR", async () => {
    mockTrustProxy = "10.0.0.0/8";
    mockRemoteAddress = "10.0.0.50";

    await makeApp().request("/entities", {
      headers: {
        "x-real-ip": "1.2.3.4",
      },
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:ip:1.2.3.4:api",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("ignores proxy headers when TRUST_PROXY does not match connecting peer CIDR", async () => {
    mockTrustProxy = "10.0.0.0/8";
    mockRemoteAddress = "172.16.0.1";

    await makeApp().request("/entities", {
      headers: {
        "x-real-ip": "1.2.3.4",
      },
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:ip:172.16.0.1:api",
      expect.any(Number),
      expect.any(Number),
    );
  });
});
