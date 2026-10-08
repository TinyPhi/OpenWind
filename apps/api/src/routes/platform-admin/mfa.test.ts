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

const mockRequestMfaCode = vi.fn();
const mockVerifyMfaCode = vi.fn();

vi.mock("@platform/auth", () => ({
  requirePlatformAdminIdentity:
    () =>
    async (
      c: Context<{ Variables: { platformAdmin: PlatformAdminAuthContext } }>,
      next: Next,
    ) => {
      c.set("platformAdmin", mockPlatformAdmin as PlatformAdminAuthContext);
      await next();
    },
  requestMfaCode: (...args: unknown[]) => mockRequestMfaCode(...args),
  verifyMfaCode: (...args: unknown[]) => mockVerifyMfaCode(...args),
}));

const { mfaRequestHandler, mfaVerifyHandler } = await import("./mfa.js");

function makeApp() {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/mfa/request", ...mfaRequestHandler);
  app.post("/mfa/verify", ...mfaVerifyHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /platform-admin/mfa/request", () => {
  it("sends a code to the platform admin's own email and returns sent:true", async () => {
    mockRequestMfaCode.mockResolvedValueOnce(undefined);
    const res = await makeApp().request("/mfa/request", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockRequestMfaCode).toHaveBeenCalledWith("pa-1", "ops@openwind.io");
    expect(await res.json()).toEqual({ data: { sent: true } });
  });

  it("returns 502 when sending fails, rather than reporting false success", async () => {
    mockRequestMfaCode.mockRejectedValueOnce(new Error("outbound down"));
    const res = await makeApp().request("/mfa/request", { method: "POST" });
    expect(res.status).toBe(502);
  });
});

describe("POST /platform-admin/mfa/verify", () => {
  it("returns verified:true on a correct code", async () => {
    mockVerifyMfaCode.mockResolvedValueOnce(true);
    const res = await makeApp().request("/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.status).toBe(200);
    expect(mockVerifyMfaCode).toHaveBeenCalledWith("pa-1", "123456");
  });

  it("returns 401 on an incorrect code", async () => {
    mockVerifyMfaCode.mockResolvedValueOnce(false);
    const res = await makeApp().request("/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 for a malformed code (not 6 digits)", async () => {
    const res = await makeApp().request("/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123" }),
    });
    expect(res.status).toBe(400);
    expect(mockVerifyMfaCode).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric 6-character code, without consuming a verify attempt (review finding, PR #804)", async () => {
    const res = await makeApp().request("/mfa/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "aaaaaa" }),
    });
    expect(res.status).toBe(400);
    expect(mockVerifyMfaCode).not.toHaveBeenCalled();
  });
});
