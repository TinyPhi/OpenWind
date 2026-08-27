import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@platform/db", () => ({
  tenants: { id: "tenants.id", config: "tenants.config" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, op: "eq" })),
  sql: (...args: unknown[]) => ({ sql: args }),
}));

let mockRow: { config: Record<string, unknown> } | undefined;
const mockUpdateSet = vi.fn();

const mockDb = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(mockRow ? [mockRow] : [])),
      })),
    })),
  })),
  update: vi.fn(() => ({
    set: (v: unknown) => {
      mockUpdateSet(v);
      return { where: vi.fn().mockResolvedValue(undefined) };
    },
  })),
};

const {
  getTenantRateLimitOverride,
  setTenantRateLimitOverride,
  _clearTenantRateLimitCacheForTests,
} = await import("./tenant-rate-limit.js");

describe("getTenantRateLimitOverride", () => {
  beforeEach(() => {
    _clearTenantRateLimitCacheForTests();
    mockRow = undefined;
    vi.clearAllMocks();
  });

  it("returns null when no override is set", async () => {
    mockRow = { config: {} };
    const result = await getTenantRateLimitOverride(
      mockDb as never,
      "tenant-1",
    );
    expect(result).toBeNull();
  });

  it("returns the configured override value", async () => {
    mockRow = { config: { rate_limit_per_min: 1200 } };
    const result = await getTenantRateLimitOverride(
      mockDb as never,
      "tenant-2",
    );
    expect(result).toBe(1200);
  });

  it("caches the result for subsequent calls within the TTL", async () => {
    mockRow = { config: { rate_limit_per_min: 900 } };
    await getTenantRateLimitOverride(mockDb as never, "tenant-3");
    mockRow = { config: { rate_limit_per_min: 111 } };
    const second = await getTenantRateLimitOverride(
      mockDb as never,
      "tenant-3",
    );
    expect(second).toBe(900);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("ignores a non-positive or non-numeric override value", async () => {
    mockRow = { config: { rate_limit_per_min: -5 } };
    const result = await getTenantRateLimitOverride(
      mockDb as never,
      "tenant-4",
    );
    expect(result).toBeNull();
  });
});

describe("setTenantRateLimitOverride", () => {
  beforeEach(() => {
    _clearTenantRateLimitCacheForTests();
    vi.clearAllMocks();
  });

  it("sets the override via jsonb_set and clears the cache", async () => {
    mockRow = { config: { rate_limit_per_min: 50 } };
    await getTenantRateLimitOverride(mockDb as never, "tenant-5");

    await setTenantRateLimitOverride(mockDb as never, "tenant-5", 750);
    expect(mockUpdateSet).toHaveBeenCalled();

    mockRow = { config: { rate_limit_per_min: 750 } };
    const result = await getTenantRateLimitOverride(
      mockDb as never,
      "tenant-5",
    );
    expect(result).toBe(750);
    expect(mockDb.select).toHaveBeenCalledTimes(2);
  });

  it("clears the override when ratePerMin is null", async () => {
    await setTenantRateLimitOverride(mockDb as never, "tenant-6", null);
    expect(mockUpdateSet).toHaveBeenCalled();
  });
});
