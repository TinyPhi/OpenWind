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

vi.mock("@platform/config", () => ({
  env: {
    PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS: 7,
    PLATFORM_ADMIN_MFA_CODE_TTL_SECONDS: 900,
  },
}));

const mockRequestMfaCode = vi.fn();
const mockVerifyMfaCode = vi.fn();
const mockEndMfaSession = vi.fn();

const { MfaResendTooSoonErrorMock, MfaLockedOutErrorMock } = vi.hoisted(() => ({
  MfaResendTooSoonErrorMock: class extends Error {
    constructor(readonly retryAfterSeconds: number) {
      super("too soon");
    }
  },
  MfaLockedOutErrorMock: class extends Error {
    constructor(readonly retryAfterSeconds: number) {
      super("locked out");
    }
  },
}));

vi.mock("@platform/auth", () => ({
  MfaResendTooSoonError: MfaResendTooSoonErrorMock,
  MfaLockedOutError: MfaLockedOutErrorMock,
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
  endMfaSession: (...args: unknown[]) => mockEndMfaSession(...args),
  PLATFORM_ADMIN_MFA_SESSION_HEADER: "X-Platform-Admin-Mfa",
}));

const { mfaRequestHandler, mfaVerifyHandler, mfaEndHandler } =
  await import("./mfa.js");

function makeApp() {
  const app = new Hono<{
    Variables: { platformAdmin: PlatformAdminAuthContext };
  }>();
  app.post("/mfa/request", ...mfaRequestHandler);
  app.post("/mfa/verify", ...mfaVerifyHandler);
  app.post("/mfa/end", ...mfaEndHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /platform-admin/mfa/request", () => {
  it("sends a code to the platform admin's own email and returns the masked address and timers", async () => {
    mockRequestMfaCode.mockResolvedValueOnce({ sentTo: "o***@openwind.io" });
    const res = await makeApp().request("/mfa/request", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockRequestMfaCode).toHaveBeenCalledWith("pa-1", "ops@openwind.io");
    expect(await res.json()).toEqual({
      data: {
        sent: true,
        sentTo: "o***@openwind.io",
        resendAfterSeconds: 7,
        expiresInSeconds: 900,
      },
    });
  });

  it("returns 429 with Retry-After and the wait when a code was just sent (#801)", async () => {
    mockRequestMfaCode.mockRejectedValueOnce(new MfaResendTooSoonErrorMock(12));
    const res = await makeApp().request("/mfa/request", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(await res.json()).toMatchObject({
      error: "MFA_RESEND_TOO_SOON",
      meta: { retryAfterSeconds: 12 },
    });
  });

  it("returns 429 with Retry-After when locked out after too many incorrect codes", async () => {
    mockRequestMfaCode.mockRejectedValueOnce(new MfaLockedOutErrorMock(1800));
    const res = await makeApp().request("/mfa/request", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1800");
    expect(await res.json()).toMatchObject({
      error: "TOO_MANY_ATTEMPTS",
      meta: { retryAfterSeconds: 1800 },
    });
  });

  it("returns 502 when sending fails, rather than reporting false success", async () => {
    mockRequestMfaCode.mockRejectedValueOnce(new Error("outbound down"));
    const res = await makeApp().request("/mfa/request", { method: "POST" });
    expect(res.status).toBe(502);
  });
});

function verify(code: string, headers: Record<string, string> = {}) {
  return makeApp().request("/mfa/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ code }),
  });
}

describe("POST /platform-admin/mfa/verify", () => {
  it("returns the new MFA session token on a correct code", async () => {
    mockVerifyMfaCode.mockResolvedValueOnce({
      ok: true,
      sessionToken: "tok-new",
    });
    const res = await verify("123456");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { verified: true, sessionToken: "tok-new" },
    });
    expect(mockVerifyMfaCode).toHaveBeenCalledWith("pa-1", "123456", undefined);
  });

  it("passes the presented session token along, so a step-up replaces it", async () => {
    mockVerifyMfaCode.mockResolvedValueOnce({
      ok: true,
      sessionToken: "tok-new",
    });
    await verify("123456", { "X-Platform-Admin-Mfa": "tok-old" });
    expect(mockVerifyMfaCode).toHaveBeenCalledWith("pa-1", "123456", "tok-old");
  });

  it("answers a wrong code with 422 INVALID_CODE and the attempts left -- never 401, which the client would replay", async () => {
    mockVerifyMfaCode.mockResolvedValueOnce({
      ok: false,
      reason: "invalid",
      attemptsRemaining: 3,
    });
    const res = await verify("000000");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "INVALID_CODE",
      meta: { attemptsRemaining: 3 },
    });
  });

  it.each([
    ["expired", "CODE_EXPIRED"],
    ["locked", "TOO_MANY_ATTEMPTS"],
  ])("answers a %s code with 422 %s", async (reason, error) => {
    mockVerifyMfaCode.mockResolvedValueOnce({ ok: false, reason });
    const res = await verify("000000");
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe(error);
    expect(body.meta).toBeUndefined();
  });

  it("returns 429 with Retry-After when verify is locked out after too many incorrect codes", async () => {
    mockVerifyMfaCode.mockResolvedValueOnce({
      ok: false,
      reason: "locked_out",
      retryAfterSeconds: 1800,
    });
    const res = await verify("000000");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1800");
    expect(await res.json()).toMatchObject({
      error: "TOO_MANY_ATTEMPTS",
      meta: { retryAfterSeconds: 1800 },
    });
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

describe("POST /platform-admin/mfa/end", () => {
  it("ends the presented session and returns 204", async () => {
    const res = await makeApp().request("/mfa/end", {
      method: "POST",
      headers: { "X-Platform-Admin-Mfa": "tok-1" },
    });
    expect(res.status).toBe(204);
    expect(mockEndMfaSession).toHaveBeenCalledWith("pa-1", "tok-1");
  });

  it("answers 204 when no session is presented (endMfaSession ignores a missing token)", async () => {
    const res = await makeApp().request("/mfa/end", { method: "POST" });
    expect(res.status).toBe(204);
    expect(mockEndMfaSession).toHaveBeenCalledWith("pa-1", undefined);
  });
});
