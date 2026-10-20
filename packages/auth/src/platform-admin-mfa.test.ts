import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisIncr = vi.fn();
const mockRedisExpire = vi.fn();
const mockRedisTtl = vi.fn();

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS: 120,
    PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS: 7,
    PLATFORM_ADMIN_MFA_VERIFIED_TTL_SECONDS: 43200,
    PLATFORM_ADMIN_MFA_CODE_TTL_SECONDS: 600,
    PLATFORM_ADMIN_MFA_MAX_VERIFY_ATTEMPTS: 5,
  },
}));

// Deliberately not the defaults (300 / 30): a window or cooldown hardcoded in the module
// would fail these tests, so they prove the values come from config.
vi.mock("@platform/config", () => ({ env: mockEnv }));

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
  MfaLockedOutError,
  MAX_FAILED_VERIFIES,
  FAILED_VERIFY_WINDOW_SECONDS,
} = await import("./platform-admin-mfa.js");
const { createHash } = await import("node:crypto");

const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
// Session tokens have the issued shape (43 base64url chars); anything else is "no session".
const tok = (c: string): string => c.repeat(43);
const TOK_A = tok("a");
const TOK_B = tok("b");

const ENV_DEFAULTS = { ...mockEnv };

beforeEach(() => {
  Object.assign(mockEnv, ENV_DEFAULTS);
  mockRedisGet.mockReset();
  mockRedisSet.mockReset();
  mockRedisDel.mockReset();
  mockRedisIncr.mockReset();
  mockRedisExpire.mockReset();
  mockRedisTtl.mockReset();
  mockSendDirectNotification.mockReset();
  mockSendDirectNotification.mockResolvedValue(undefined);
  mockLoggerInfo.mockReset();
});

describe("configurable MFA timings (#929)", () => {
  function arrangeAttempt(code: string, attempt: number): void {
    mockRedisGet
      .mockResolvedValueOnce(null) // lockedOutFor: failed counter
      .mockResolvedValueOnce(sha(code)); // stored code
    mockRedisIncr.mockResolvedValueOnce(attempt).mockResolvedValueOnce(1);
  }

  it("stores the code and its attempts counter with the configured code lifetime", async () => {
    mockEnv.PLATFORM_ADMIN_MFA_CODE_TTL_SECONDS = 1200;
    await requestMfaCode("pa-1", "pa@example.com");
    expect(mockRedisSet).toHaveBeenCalledWith(
      "platform-admin:mfa:otp:pa-1",
      expect.any(String),
      "EX",
      1200,
    );
    arrangeAttempt("111111", 1);
    await verifyMfaCode("pa-1", "000000");
    expect(mockRedisExpire).toHaveBeenCalledWith(
      "platform-admin:mfa:attempts:pa-1",
      1200,
      "NX",
    );
  });

  it.each([
    [600, 10],
    [601, 11],
    [90, 2],
    [1800, 30],
  ])(
    "emails a lifetime of %i seconds as %i minutes (rounded up)",
    async (seconds, minutes) => {
      mockEnv.PLATFORM_ADMIN_MFA_CODE_TTL_SECONDS = seconds;
      await requestMfaCode("pa-1", "pa@example.com");
      const body = mockSendDirectNotification.mock.calls[0]?.[0].body as string;
      expect(body).toContain(`expires in ${minutes} minutes`);
    },
  );

  it("sets the verified marker TTL from the configured verified lifetime", async () => {
    mockEnv.PLATFORM_ADMIN_MFA_VERIFIED_TTL_SECONDS = 7200;
    arrangeAttempt("654321", 1);
    const result = await verifyMfaCode("pa-1", "654321");
    const token = (result as { sessionToken: string }).sessionToken;
    expect(mockRedisSet).toHaveBeenCalledWith(
      `platform-admin:mfa:verified:pa-1:${sha(token)}`,
      "1",
      "EX",
      7200,
    );
  });

  it("locks the code after the configured number of wrong guesses", async () => {
    mockEnv.PLATFORM_ADMIN_MFA_MAX_VERIFY_ATTEMPTS = 2;
    arrangeAttempt("654321", 1);
    expect(await verifyMfaCode("pa-1", "000000")).toEqual({
      ok: false,
      reason: "invalid",
      attemptsRemaining: 1,
    });
    arrangeAttempt("654321", 2);
    expect(await verifyMfaCode("pa-1", "000000")).toEqual({
      ok: false,
      reason: "locked",
    });
    expect(mockRedisDel).toHaveBeenCalledWith("platform-admin:mfa:otp:pa-1");
    arrangeAttempt("654321", 3);
    expect(await verifyMfaCode("pa-1", "654321")).toEqual({
      ok: false,
      reason: "locked",
    });
  });
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

  it("refuses to send a code when the admin is locked out after too many incorrect guesses", async () => {
    mockRedisGet.mockResolvedValueOnce(String(MAX_FAILED_VERIFIES));
    mockRedisTtl.mockResolvedValueOnce(1200);

    const err = await requestMfaCode("pa-1", "pa@example.com").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(MfaLockedOutError);
    expect(
      (err as InstanceType<typeof MfaLockedOutError>).retryAfterSeconds,
    ).toBe(1200);
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockSendDirectNotification).not.toHaveBeenCalled();
  });

  it("never deletes the persistent failed counter on resend", async () => {
    await requestMfaCode("pa-1", "pa@example.com");

    expect(mockRedisDel).toHaveBeenCalledWith(
      "platform-admin:mfa:attempts:pa-1",
    );
    expect(mockRedisDel).not.toHaveBeenCalledWith(
      expect.stringContaining("platform-admin:mfa:failed:"),
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
  // Reads in order: the per-admin failure count (the lockout check), then the code. A wrong
  // code increments the per-code attempts, then the per-admin failures.
  function arrangeStoredCode(code: string, attempt = 1, failures = 0): void {
    mockRedisGet
      .mockResolvedValueOnce(failures ? String(failures) : null)
      .mockResolvedValueOnce(sha(code));
    mockRedisIncr
      .mockResolvedValueOnce(attempt)
      .mockResolvedValueOnce(failures + 1);
  }

  it("reports 'expired' when no code is outstanding", async () => {
    mockRedisGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
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

  it("refuses verify and deletes the outstanding code when the admin is locked out", async () => {
    mockRedisGet.mockResolvedValueOnce(String(MAX_FAILED_VERIFIES)); // failures >= 5
    mockRedisTtl.mockResolvedValueOnce(900);

    const result = await verifyMfaCode("pa-1", "654321");
    expect(result).toEqual({
      ok: false,
      reason: "locked_out",
      retryAfterSeconds: 900,
    });
    expect(mockRedisDel).toHaveBeenCalledWith("platform-admin:mfa:otp:pa-1");
  });

  it("reports 'locked_out' when wrong guesses reach MAX_FAILED_VERIFIES", async () => {
    // 0 failures initially, 5th wrong guess pushes failures to 5
    mockRedisGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sha("654321"));
    mockRedisIncr
      .mockResolvedValueOnce(1) // attempts
      .mockResolvedValueOnce(MAX_FAILED_VERIFIES); // failures reaches 5
    mockRedisTtl.mockResolvedValueOnce(1800);

    const result = await verifyMfaCode("pa-1", "000000");
    expect(result).toEqual({
      ok: false,
      reason: "locked_out",
      retryAfterSeconds: 1800,
    });
    expect(mockRedisDel).toHaveBeenCalledWith("platform-admin:mfa:otp:pa-1");
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

  it("resets attempts and the persistent failed counter on a successful verify", async () => {
    arrangeStoredCode("654321");

    await verifyMfaCode("pa-1", "654321");

    expect(mockRedisDel).toHaveBeenCalledWith(
      "platform-admin:mfa:otp:pa-1",
      "platform-admin:mfa:attempts:pa-1",
      "platform-admin:mfa:failed:pa-1",
    );
  });
});

describe("cross-resend lockout (PR #947 R3/R4 finding 1)", () => {
  function setupFakeRedis() {
    const store = new Map<string, string>();
    const ttls = new Map<string, number>();

    mockRedisGet.mockImplementation(
      async (key: string) => store.get(key) ?? null,
    );
    mockRedisSet.mockImplementation(
      async (key: string, val: string, ...args: unknown[]) => {
        if (args.includes("NX") && store.has(key)) return null;
        store.set(key, val);
        return "OK";
      },
    );
    mockRedisDel.mockImplementation(async (...keys: string[]) => {
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    });
    mockRedisIncr.mockImplementation(async (key: string) => {
      const val = Number(store.get(key) || 0) + 1;
      store.set(key, String(val));
      return val;
    });
    mockRedisExpire.mockImplementation(async (key: string, seconds: number) => {
      ttls.set(key, seconds);
      return 1;
    });
    mockRedisTtl.mockImplementation(async (key: string) => {
      if (!store.has(key)) return -2;
      return ttls.get(key) ?? FAILED_VERIFY_WINDOW_SECONDS;
    });

    return { store, ttls };
  }

  it("locks out an admin after 5 wrong guesses across resends: request -> 5 wrong -> request (resend) refused -> verify refused", async () => {
    const { store } = setupFakeRedis();

    // 1. request
    await requestMfaCode("pa-1", "ops@openwind.io");
    expect(store.has("platform-admin:mfa:otp:pa-1")).toBe(true);

    // 2. 5 wrong guesses
    for (let i = 1; i <= 4; i++) {
      const res = await verifyMfaCode("pa-1", "000000");
      expect(res).toEqual({
        ok: false,
        reason: "invalid",
        attemptsRemaining: 5 - i,
      });
    }
    const fifth = await verifyMfaCode("pa-1", "000000");
    expect(fifth).toMatchObject({
      ok: false,
      reason: "locked_out",
      retryAfterSeconds: expect.any(Number),
    });

    // 3. request (resend) refused
    await expect(requestMfaCode("pa-1", "ops@openwind.io")).rejects.toThrow(
      MfaLockedOutError,
    );

    // 4. verify refused
    const verifyAttempt = await verifyMfaCode("pa-1", "000000");
    expect(verifyAttempt).toMatchObject({
      ok: false,
      reason: "locked_out",
    });

    // 5. request refused again
    await expect(requestMfaCode("pa-1", "ops@openwind.io")).rejects.toThrow(
      MfaLockedOutError,
    );
  });

  it("accumulates failed guesses across resends and does not reset failed counter on resend", async () => {
    const { store } = setupFakeRedis();

    // Request 1
    await requestMfaCode("pa-1", "ops@openwind.io");

    // 3 wrong guesses on code 1
    for (let i = 0; i < 3; i++) {
      await verifyMfaCode("pa-1", "000000");
    }
    expect(store.get("platform-admin:mfa:failed:pa-1")).toBe("3");

    // Simulate cooldown expiry so resend is allowed
    store.delete("platform-admin:mfa:resend:pa-1");

    // Resend (request code 2)
    await requestMfaCode("pa-1", "ops@openwind.io");
    // attemptsKey was reset for the new code
    expect(store.has("platform-admin:mfa:attempts:pa-1")).toBe(false);
    // but failedKey was NOT reset!
    expect(store.get("platform-admin:mfa:failed:pa-1")).toBe("3");

    // 1st wrong guess on code 2 (total 4)
    const g4 = await verifyMfaCode("pa-1", "000000");
    expect(g4).toMatchObject({
      ok: false,
      reason: "invalid",
      attemptsRemaining: 4,
    });
    expect(store.get("platform-admin:mfa:failed:pa-1")).toBe("4");

    // 2nd wrong guess on code 2 (total 5 -> lockout!)
    const g5 = await verifyMfaCode("pa-1", "000000");
    expect(g5).toMatchObject({ ok: false, reason: "locked_out" });
    expect(store.get("platform-admin:mfa:failed:pa-1")).toBe("5");

    // Further request and verify are refused
    await expect(requestMfaCode("pa-1", "ops@openwind.io")).rejects.toThrow(
      MfaLockedOutError,
    );
    expect(await verifyMfaCode("pa-1", "123456")).toMatchObject({
      ok: false,
      reason: "locked_out",
    });
  });

  it("resets the failed counter on a successful verification", async () => {
    const { store } = setupFakeRedis();

    await requestMfaCode("pa-1", "ops@openwind.io");
    // 2 wrong guesses
    await verifyMfaCode("pa-1", "000000");
    await verifyMfaCode("pa-1", "000000");
    expect(store.get("platform-admin:mfa:failed:pa-1")).toBe("2");

    // Extract the plaintext code from notification mock call
    const lastCall = mockSendDirectNotification.mock.calls.at(-1);
    const codeMatch = (lastCall[0].body as string).match(/\b\d{6}\b/);
    expect(codeMatch).toBeTruthy();
    const verified = await verifyMfaCode("pa-1", codeMatch![0]);
    expect(verified.ok).toBe(true);

    // failed counter must be deleted
    expect(store.has("platform-admin:mfa:failed:pa-1")).toBe(false);
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
