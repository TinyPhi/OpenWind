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

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  requestMfaCode,
  verifyMfaCode,
  isMfaVerified,
  isMfaFresh,
  MfaResendTooSoonError,
} = await import("./platform-admin-mfa.js");

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

  it("propagates a send failure instead of swallowing it", async () => {
    mockSendDirectNotification.mockRejectedValueOnce(new Error("send failed"));
    await expect(requestMfaCode("pa-1", "pa@example.com")).rejects.toThrow(
      "send failed",
    );
  });
});

describe("verifyMfaCode", () => {
  it("returns false when no code was requested", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    const result = await verifyMfaCode("pa-1", "123456");
    expect(result).toBe(false);
  });

  it("returns false and does not set verified on an incorrect code", async () => {
    mockRedisGet.mockResolvedValueOnce("some-other-hash");
    mockRedisIncr.mockResolvedValueOnce(1);
    const result = await verifyMfaCode("pa-1", "000000");
    expect(result).toBe(false);
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  it("locks out further attempts after MAX_VERIFY_ATTEMPTS", async () => {
    mockRedisGet.mockResolvedValue("some-hash");
    mockRedisIncr.mockResolvedValueOnce(6); // over the limit of 5
    const result = await verifyMfaCode("pa-1", "000000");
    expect(result).toBe(false);
    expect(mockRedisDel).toHaveBeenCalledWith(
      "platform-admin:mfa:otp:pa-1",
      "platform-admin:mfa:attempts:pa-1",
    );
  });

  it("returns true and sets the verified flag on a correct code", async () => {
    const { createHash } = await import("node:crypto");
    const correctHash = createHash("sha256").update("654321").digest("hex");
    mockRedisGet.mockResolvedValueOnce(correctHash);
    mockRedisIncr.mockResolvedValueOnce(1);

    const result = await verifyMfaCode("pa-1", "654321");

    expect(result).toBe(true);
    expect(mockRedisSet).toHaveBeenCalledWith(
      "platform-admin:mfa:verified:pa-1",
      "1",
      "EX",
      12 * 60 * 60,
    );
  });

  it("also sets the step-up fresh marker, lasting the configured window (not the 12h flag)", async () => {
    const { createHash } = await import("node:crypto");
    mockRedisGet.mockResolvedValueOnce(
      createHash("sha256").update("654321").digest("hex"),
    );
    mockRedisIncr.mockResolvedValueOnce(1);

    await verifyMfaCode("pa-1", "654321");

    expect(mockRedisSet).toHaveBeenCalledWith(
      "platform-admin:mfa:fresh:pa-1",
      "1",
      "EX",
      120,
    );
  });

  it("sets neither flag on an incorrect code", async () => {
    mockRedisGet.mockResolvedValueOnce("not-the-hash");
    mockRedisIncr.mockResolvedValueOnce(1);

    await verifyMfaCode("pa-1", "000000");

    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});

describe("isMfaVerified", () => {
  it("returns true when the verified flag is present", async () => {
    mockRedisGet.mockResolvedValueOnce("1");
    expect(await isMfaVerified("pa-1")).toBe(true);
  });

  it("returns false when the verified flag is absent", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    expect(await isMfaVerified("pa-1")).toBe(false);
  });

  it("fails closed (false) when Redis throws", async () => {
    mockRedisGet.mockRejectedValueOnce(new Error("redis down"));
    expect(await isMfaVerified("pa-1")).toBe(false);
  });
});

describe("isMfaFresh", () => {
  it("returns true when the fresh marker is present", async () => {
    mockRedisGet.mockResolvedValueOnce("1");
    expect(await isMfaFresh("pa-1")).toBe(true);
    expect(mockRedisGet).toHaveBeenCalledWith("platform-admin:mfa:fresh:pa-1");
  });

  it("returns false when the marker is absent or has expired", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    expect(await isMfaFresh("pa-1")).toBe(false);
  });

  it("is independent of the 12h verified flag (a verified-but-stale admin is not fresh)", async () => {
    mockRedisGet.mockImplementation(async (key: string) =>
      key === "platform-admin:mfa:verified:pa-1" ? "1" : null,
    );
    expect(await isMfaVerified("pa-1")).toBe(true);
    expect(await isMfaFresh("pa-1")).toBe(false);
    mockRedisGet.mockReset();
  });

  it("fails closed (false) when Redis throws", async () => {
    mockRedisGet.mockRejectedValueOnce(new Error("redis down"));
    expect(await isMfaFresh("pa-1")).toBe(false);
  });
});
