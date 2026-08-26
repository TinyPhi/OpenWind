import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

let mockNodeEnv: string | undefined = "test";
vi.mock("@platform/config", () => ({
  env: {
    get NODE_ENV() {
      return mockNodeEnv;
    },
  },
}));

const { httpsEnforcement } = await import("./https-enforcement.js");

function makeApp() {
  const app = new Hono();
  app.use("*", httpsEnforcement());
  app.get("/health", (c) => c.json({ status: "ok" }));
  return app;
}

describe("httpsEnforcement", () => {
  it("does nothing outside production, even with an http x-forwarded-proto", async () => {
    mockNodeEnv = "test";
    const app = makeApp();
    const res = await app.request("/health", {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects an explicit http x-forwarded-proto in production", async () => {
    mockNodeEnv = "production";
    const app = makeApp();
    const res = await app.request("/health", {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("HTTPS_REQUIRED");
  });

  it("allows an explicit https x-forwarded-proto in production", async () => {
    mockNodeEnv = "production";
    const app = makeApp();
    const res = await app.request("/health", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
  });

  it("does not reject in production when the header is absent (can't tell http from https)", async () => {
    mockNodeEnv = "production";
    const app = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});
