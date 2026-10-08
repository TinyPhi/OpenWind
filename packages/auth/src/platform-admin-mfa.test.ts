import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisIncr = vi.fn();
const mockRedisExpire = vi.fn();

vi.mock("@platform/redis", () => ({
  getRedis: () => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    incr: mockRedisIncr,
    expire: mockRedisExpire,
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

const { requestMfaCode, verifyMfaCode, isMfaVerified } =
  await import("./platform-admin-mfa.js");

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
    const storedHash = mockRedisSet.mock.calls[0]?.[1] as string;
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
