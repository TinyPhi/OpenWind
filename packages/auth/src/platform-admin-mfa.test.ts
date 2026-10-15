import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisIncr = vi.fn();
const mockRedisExpire = vi.fn();
const mockRedisTtl = vi.fn();

// Deliberately not the defaults (300 / 30): a window or cooldown hardcoded in the module
// would fail these tests, so they prove the values come from config.
vi.mock("@platform/config", () => ({
  env: {
    PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS: 120,
    PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS: 7,
  },
}));

vi.mock("@platform/redis", () => ({
  getRedis: () => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    incr: mockRedisIncr,
    expire: mockRedisExpire,
    ttl: mockRedisTtl,
  }),
  withRedisTimeout: async (fn: () => Promise<unknown>, fallback: unknown) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  },
}));

const mockSendDirectNotification = vi.fn();
vi.mock("@platform/notifications", () => ({
  sendDirectNotification: (...args: unknown[]) =>
    mockSendDirectNotification(...args),
}));

const mockLoggerInfo = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: { info: mockLoggerInfo, warn: vi.fn(), error: vi.fn() },
}));

const {
  requestMfaCode,
  verifyMfaCode,
  isMfaVerified,
  isMfaFresh,
  endMfaSession,
  maskEmail,
  MfaResendTooSoonError,
} = await import("./platform-admin-mfa.js");
const { createHash } = await import("node:crypto");

const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
// Session tokens have the issued shape (43 base64url chars); anything else is "no session".
const tok = (c: string): string => c.repeat(43);
const TOK_A = tok("a");
const TOK_B = tok("b");

beforeEach(() => {
  vi.clearAllMocks();
  mockSendDirectNotification.mockResolvedValue(undefined);
});

describe("requestMfaCode", () => {
  it("stores a hashed code (never the plaintext) with a TTL and emails it", async () => {
    await requestMfaCode("pa-1", "pa@example.com");

    expect(mockRedisSet).toHaveBeenCalledWith(
      "platform-admin:mfa:otp:pa-1",
      expect.any(String),
      "EX",
      600,
    );
    const storedHash = mockRedisSet.mock.calls.find(
      (c) => c[0] === "platform-admin:mfa:otp:pa-1",
    )?.[1] as string;
    expect(storedHash).not.toMatch(/^\d{6}$/); // never the plain 6-digit code
    expect(mockRedisDel).toHaveBeenCalledWith(
      "platform-admin:mfa:attempts:pa-1",
    );

    expect(mockSendDirectNotification).toHaveBeenCalledTimes(1);
    const payload = mockSendDirectNotification.mock.calls[0]?.[0];
    expect(payload.recipients).toEqual([
      { userId: "pa-1", email: "pa@example.com" },
    ]);
    expect(payload.body).toMatch(/\d{6}/);
  });

  it("claims a per-admin resend cooldown (NX) of the configured length before issuing a code", async () => {
    await requestMfaCode("pa-1", "pa@example.com");

    expect(mockRedisSet).toHaveBeenNthCalledWith(
      1,
      "platform-admin:mfa:resend:pa-1",
      "1",
      "EX",
      7,
      "NX",
    );
  });

  it("refuses a resend inside the cooldown, reports how long to wait, and leaves the existing code alone", async () => {
    mockRedisSet.mockResolvedValueOnce(null); // NX not claimed: still cooling down
    mockRedisTtl.mockResolvedValueOnce(4);

    const err = await requestMfaCode("pa-1", "pa@example.com").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MfaResendTooSoonError);
    expect(
      (err as InstanceType<typeof MfaResendTooSoonError>).retryAfterSeconds,
    ).toBe(4);
    expect(mockRedisSet).toHaveBeenCalledTimes(1); // only the cooldown claim
    expect(mockRedisDel).not.toHaveBeenCalled(); // attempts counter and code untouched
    expect(mockSendDirectNotification).not.toHaveBeenCalled();
  });

  it("says to retry in a second when Redis reports no remaining TTL (the key just expired), not a config value", async () => {
    mockRedisSet.mockResolvedValueOnce(null);
    mockRedisTtl.mockResolvedValueOnce(-2);

    const err = await requestMfaCode("pa-1", "pa@example.com").catch(
      (e: unknown) => e,
    );

    expect(
      (err as InstanceType<typeof MfaResendTooSoonError>).retryAfterSeconds,
    ).toBe(1);
  });

  it("releases the resend cooldown when the email fails to send, so the admin can retry at once", async () => {
    mockSendDirectNotification.mockRejectedValueOnce(new Error("send failed"));

    await expect(requestMfaCode("pa-1", "pa@example.com")).rejects.toThrow(
      "send failed",
    );

    expect(mockRedisDel).toHaveBeenCalledWith("platform-admin:mfa:resend:pa-1");
  });

  it("keeps the cooldown when the email was sent", async () => {
    await requestMfaCode("pa-1", "pa@example.com");

    expect(mockRedisDel).not.toHaveBeenCalledWith(
      "platform-admin:mfa:resend:pa-1",
    );
  });

  it("returns and logs only the masked recipient address", async () => {
    const result = await requestMfaCode("pa-1", "pat.smith@example.com");

    expect(result).toEqual({ sentTo: "p***@example.com" });
    const logged = JSON.stringify(mockLoggerInfo.mock.calls);
    expect(logged).toContain("p***@example.com");
    expect(logged).not.toContain("pat.smith");
  });

  it("propagates a send failure instead of swallowing it", async () => {
    mockSendDirectNotification.mockRejectedValueOnce(new Error("send failed"));
    await expect(requestMfaCode("pa-1", "pa@example.com")).rejects.toThrow(
      "send failed",
    );
  });
});

describe("maskEmail", () => {
  it.each([
    ["pat.smith@example.com", "p***@example.com"],
    ["a@b.io", "a***@b.io"],
    ["no-at-sign", "***"],
    ["@example.com", "***"],
  ])("%s -> %s", (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});

describe("verifyMfaCode", () => {
  function arrangeStoredCode(code: string, attempt = 1): void {
    mockRedisGet.mockResolvedValueOnce(sha(code));
    mockRedisIncr.mockResolvedValueOnce(attempt);
  }

  it("reports 'expired' when no code is outstanding", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    expect(await verifyMfaCode("pa-1", "123456")).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("reports 'invalid' with the attempts left, and sets nothing, on a wrong code", async () => {
    arrangeStoredCode("654321", 2);

    expect(await verifyMfaCode("pa-1", "000000")).toEqual({
      ok: false,
      reason: "invalid",
      attemptsRemaining: 3,
    });
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("invalidates the code and reports 'locked' on the last allowed wrong guess, keeping the counter", async () => {
    arrangeStoredCode("654321", 5);

    expect(await verifyMfaCode("pa-1", "000000")).toEqual({
      ok: false,
      reason: "locked",
    });
    // Only the code goes: parallel stragglers must still see a count over the limit.
    expect(mockRedisDel).toHaveBeenCalledWith("platform-admin:mfa:otp:pa-1");
    expect(mockRedisDel).not.toHaveBeenCalledWith(
      expect.anything(),
      "platform-admin:mfa:attempts:pa-1",
    );
  });

  it("reports 'locked' without comparing once past the limit", async () => {
    arrangeStoredCode("654321", 6);

    expect(await verifyMfaCode("pa-1", "654321")).toEqual({
      ok: false,
      reason: "locked",
    });
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("issues a new MFA session token and keys the verified (12h) and fresh markers by its hash", async () => {
    arrangeStoredCode("654321");

    const result = await verifyMfaCode("pa-1", "654321");

    expect(result.ok).toBe(true);
    const token = (result as { sessionToken: string }).sessionToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mockRedisSet).toHaveBeenCalledWith(
      `platform-admin:mfa:verified:pa-1:${sha(token)}`,
      "1",
      "EX",
      12 * 60 * 60,
    );
    expect(mockRedisSet).toHaveBeenCalledWith(
      `platform-admin:mfa:fresh:pa-1:${sha(token)}`,
      "1",
      "EX",
      120,
    );
    // The token itself is never stored.
    expect(JSON.stringify(mockRedisSet.mock.calls)).not.toContain(token);
  });

  it("issues a different token on every verification", async () => {
    arrangeStoredCode("654321");
    const first = await verifyMfaCode("pa-1", "654321");
    arrangeStoredCode("654321");
    const second = await verifyMfaCode("pa-1", "654321");

    expect(first).not.toEqual(second);
  });

  it("ends the presented session when a step-up verification replaces it", async () => {
    arrangeStoredCode("654321");

    await verifyMfaCode("pa-1", "654321", TOK_A);

    expect(mockRedisDel).toHaveBeenCalledWith(
      `platform-admin:mfa:verified:pa-1:${sha(TOK_A)}`,
      `platform-admin:mfa:fresh:pa-1:${sha(TOK_A)}`,
    );
  });
});

describe("endMfaSession", () => {
  it("deletes only that session's markers", async () => {
    await endMfaSession("pa-1", TOK_A);

    expect(mockRedisDel).toHaveBeenCalledWith(
      `platform-admin:mfa:verified:pa-1:${sha(TOK_A)}`,
      `platform-admin:mfa:fresh:pa-1:${sha(TOK_A)}`,
    );
  });

  it.each([undefined, "", "short", `${tok("a")}!`, tok("a") + "a"])(
    "ignores a missing or malformed token (%s) without touching Redis",
    async (raw) => {
      await endMfaSession("pa-1", raw);
      expect(mockRedisDel).not.toHaveBeenCalled();
    },
  );
});

describe("isMfaVerified", () => {
  it("is true only for the session token that was verified", async () => {
    mockRedisGet.mockImplementation(async (key: string) =>
      key === `platform-admin:mfa:verified:pa-1:${sha(TOK_A)}` ? "1" : null,
    );
    expect(await isMfaVerified("pa-1", TOK_A)).toBe(true);
    expect(await isMfaVerified("pa-1", TOK_B)).toBe(false); // another browser / sign-in
    expect(await isMfaVerified("pa-2", TOK_A)).toBe(false); // another admin
    mockRedisGet.mockReset();
  });

  it("is false without a well-formed session token, without asking Redis", async () => {
    expect(await isMfaVerified("pa-1", undefined)).toBe(false);
    expect(await isMfaVerified("pa-1", "not-a-token")).toBe(false);
    expect(await isMfaVerified("pa-1", "x".repeat(5000))).toBe(false);
    expect(mockRedisGet).not.toHaveBeenCalled();
  });

  it("fails closed (false) when Redis throws", async () => {
    mockRedisGet.mockRejectedValueOnce(new Error("redis down"));
    expect(await isMfaVerified("pa-1", TOK_A)).toBe(false);
  });
});

describe("isMfaFresh", () => {
  it("returns true when this session's fresh marker is present", async () => {
    mockRedisGet.mockResolvedValueOnce("1");
    expect(await isMfaFresh("pa-1", TOK_A)).toBe(true);
    expect(mockRedisGet).toHaveBeenCalledWith(
      `platform-admin:mfa:fresh:pa-1:${sha(TOK_A)}`,
    );
  });

  it("returns false when the marker is absent or has expired", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    expect(await isMfaFresh("pa-1", TOK_A)).toBe(false);
  });

  it("is independent of the verified flag (a verified-but-stale session is not fresh)", async () => {
    mockRedisGet.mockImplementation(async (key: string) =>
      key.startsWith("platform-admin:mfa:verified:") ? "1" : null,
    );
    expect(await isMfaVerified("pa-1", TOK_A)).toBe(true);
    expect(await isMfaFresh("pa-1", TOK_A)).toBe(false);
    mockRedisGet.mockReset();
  });

  it("is false without a well-formed session token", async () => {
    expect(await isMfaFresh("pa-1", undefined)).toBe(false);
    expect(await isMfaFresh("pa-1", "tok")).toBe(false);
  });

  it("fails closed (false) when Redis throws", async () => {
    mockRedisGet.mockRejectedValueOnce(new Error("redis down"));
    expect(await isMfaFresh("pa-1", TOK_A)).toBe(false);
  });
});
