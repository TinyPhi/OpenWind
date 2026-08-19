import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { rateLimit } from "./rate-limit.js";

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

  it("takes only the first hop of a chained x-forwarded-for header", async () => {
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

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
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
});
