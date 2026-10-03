import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@platform/config", () => ({
  env: { RATE_LIMIT_API_KEY_PERSON_PER_MIN: 20, RATE_LIMIT_EXPORT_PER_MIN: 5 },
}));

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn() },
}));

const mockCheckRateLimit = vi.fn();
vi.mock("@platform/redis", () => ({
  getRedis: vi.fn(() => ({})),
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const { enforceKeyPersonRateLimit, enforceExportRateLimit } =
  await import("./rate-limit-tiers.js");

describe("enforceKeyPersonRateLimit", () => {
  beforeEach(() => {
    mockCheckRateLimit.mockReset();
  });

  it("keys the check on tenant + api key + acting person together", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: true,
      remaining: 19,
      resetAt: 1,
    });

    await enforceKeyPersonRateLimit("tenant-a", "key-1", "person-1");

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:key-person:tenant-a:key-1:person-1",
      20,
      60,
    );
  });

  it("returns allowed:false when the tier is exceeded", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: 123,
    });

    const result = await enforceKeyPersonRateLimit(
      "tenant-a",
      "key-1",
      "person-1",
    );

    expect(result.allowed).toBe(false);
  });

  it("fails open (allowed:true) when the underlying check throws", async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error("redis down"));

    const result = await enforceKeyPersonRateLimit(
      "tenant-a",
      "key-1",
      "person-1",
    );

    expect(result.allowed).toBe(true);
  });

  it("gives two different acting people on the same key independent buckets", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 19,
      resetAt: 1,
    });

    await enforceKeyPersonRateLimit("tenant-a", "key-1", "person-1");
    await enforceKeyPersonRateLimit("tenant-a", "key-1", "person-2");

    const keys = mockCheckRateLimit.mock.calls.map((c) => c[1] as string);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("enforceExportRateLimit", () => {
  beforeEach(() => {
    mockCheckRateLimit.mockReset();
  });

  it("keys the check on tenant + user with a 5-per-60s budget", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: true,
      remaining: 4,
      resetAt: 1,
    });

    await enforceExportRateLimit("tenant-a", "user-1");

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "rl:export:tenant-a:user-1",
      5,
      60,
    );
  });

  it("gives different users, and the same user in different tenants, independent buckets", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: true,
      remaining: 4,
      resetAt: 1,
    });

    await enforceExportRateLimit("tenant-a", "user-1");
    await enforceExportRateLimit("tenant-a", "user-2");
    await enforceExportRateLimit("tenant-b", "user-1");

    const keys = mockCheckRateLimit.mock.calls.map((c) => c[1] as string);
    expect(new Set(keys).size).toBe(3);
  });

  it("returns allowed:false when the budget is spent", async () => {
    mockCheckRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: 123,
    });

    const result = await enforceExportRateLimit("tenant-a", "user-1");

    expect(result.allowed).toBe(false);
  });

  it("fails open (allowed:true) when the underlying check throws", async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error("redis down"));

    const result = await enforceExportRateLimit("tenant-a", "user-1");

    expect(result.allowed).toBe(true);
  });
});
