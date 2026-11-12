import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import type * as Auth from "@platform/auth";
import type { AuthContext } from "@platform/auth";

const mockCapture = vi.fn();
const mockRateLimit = vi.fn();

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

vi.mock("@platform/telemetry", () => ({
  captureException: (...args: unknown[]) => mockCapture(...args),
}));

vi.mock("../../lib/rate-limit-tiers.js", () => ({
  enforceClientErrorRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { reportClientErrorHandler } = await import("./report.js");

function makeApp(): Hono<{ Variables: { auth: AuthContext } }> {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.post("/client-errors", ...reportClientErrorHandler);
  return app;
}

const post = (body: unknown): Promise<Response> =>
  makeApp().request("/client-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const valid = {
  kind: "route_boundary",
  message: "Failed to fetch dynamically imported module: /assets/x.js",
  stack: "Error: boom\n    at x.js:1:1",
  componentStack: "\n    at Records",
  path: "/records?token=abc#frag",
};

describe("POST /client-errors (#810)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetAt: 0,
    });
  });

  it("forwards a ClientError to error tracking and answers 204", async () => {
    const res = await post(valid);
    expect(res.status).toBe(204);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    const err = mockCapture.mock.calls[0]?.[0] as Error;
    expect(err.name).toBe("ClientError");
    expect(err.message).toBe(valid.message);
    expect(err.stack).toContain("component | at Records");
  });

  it("keeps only the path of the page, never its query or fragment", async () => {
    await post(valid);
    const err = mockCapture.mock.calls[0]?.[0] as Error;
    expect(err.stack).toContain("page | /records");
    expect(err.stack).not.toContain("token=abc");
    expect(err.stack).not.toContain("frag");
  });

  it("cannot pass a forged server stack: lines are prefixed and the message is one line", async () => {
    await post({
      ...valid,
      message: "boom\n    at realServerFn (/app/dist/x.js:1:1)",
      stack: "Error: x\n    at realServerFn (/app/dist/x.js:1:1?token=abc)",
    });
    const err = mockCapture.mock.calls[0]?.[0] as Error;
    expect(err.message).not.toContain("\n");
    for (const line of (err.stack ?? "").split("\n").slice(1)) {
      expect(line).toMatch(/^ {4}(browser|component|page) \| /);
    }
    expect(err.stack).not.toContain("token=abc");
  });

  it("refuses an unknown kind, a missing message and oversized fields with 4xx", async () => {
    expect(
      (await post({ ...valid, kind: "other" })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await post({ kind: "route_boundary" })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await post({ ...valid, stack: "x".repeat(8_001) })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("refuses a body over the size cap with 413", async () => {
    const res = await post({ ...valid, stack: "x".repeat(20_000) });
    expect(res.status).toBe(413);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After when the user is over the limit, and reports nothing", async () => {
    mockRateLimit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Math.ceil(Date.now() / 1000) + 30,
    });
    const res = await post(valid);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("rate limits on the verified tenant and user, not on anything in the body", async () => {
    await post(valid);
    expect(mockRateLimit).toHaveBeenCalledWith("t-aaa", "u-bbb");
  });
});
