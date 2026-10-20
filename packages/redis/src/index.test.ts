import { describe, it, expect, vi, afterEach } from "vitest";

// vi.hoisted ensures these are available inside vi.mock factories (ESM hoisting).
// Implementation uses a regular function (not arrow) — vitest internally calls
// mockImplementation with `new`, and arrow functions cannot be constructors.
const { mockOn, mockQuit, MockRedis } = vi.hoisted(() => {
  const mockOn = vi.fn();
  const mockQuit = vi.fn().mockResolvedValue("OK");
  const MockRedis = vi.fn().mockImplementation(function (this: {
    on: typeof mockOn;
    quit: typeof mockQuit;
    status: string;
  }) {
    this.on = mockOn;
    this.quit = mockQuit;
    this.status = "ready";
  });
  return { mockOn, mockQuit, MockRedis };
});

vi.mock("ioredis", () => ({ default: MockRedis }));
const { mockEnv, mockWarn } = vi.hoisted(() => ({
  mockEnv: {
    REDIS_URL: "redis://localhost:6379",
    REDIS_CACHE_URL: undefined as string | undefined,
    NODE_ENV: "test",
  },
  mockWarn: vi.fn(),
}));
vi.mock("@platform/config", () => ({ env: mockEnv }));
vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: mockWarn },
}));

// Import AFTER mocks so the module captures the mocked constructor.
const { getRedis, getCacheRedis, closeRedis } = await import("./index.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(async () => {
  // Close first so the quit() call happens before we reset counters.
  // Reversing this order leaks the cleanup quit() into the next test's call counts.
  // Use individual mockClear() — vi.clearAllMocks() would wipe MockRedis.mockImplementation.
  await closeRedis();
  mockOn.mockClear();
  mockQuit.mockClear();
  MockRedis.mockClear();
  mockWarn.mockClear();
  mockEnv.REDIS_CACHE_URL = undefined;
  mockEnv.NODE_ENV = "test";
});

describe("getRedis", () => {
  it("returns the same instance on repeated calls (singleton)", () => {
    const a = getRedis();
    const b = getRedis();
    expect(a).toBe(b);
    expect(MockRedis).toHaveBeenCalledTimes(1);
  });

  it("constructs the client with REDIS_URL from config", () => {
    getRedis();
    expect(MockRedis).toHaveBeenCalledWith("redis://localhost:6379", {
      lazyConnect: false,
    });
  });

  it("registers an error handler on the client", () => {
    getRedis();
    expect(mockOn).toHaveBeenCalledWith("error", expect.any(Function));
  });
});

describe("closeRedis", () => {
  it("calls quit() on the existing client", async () => {
    getRedis();
    await closeRedis();
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });

  it("nulls the singleton so the next getRedis() creates a fresh client", async () => {
    getRedis();
    await closeRedis();
    MockRedis.mockClear(); // clear call count only, not implementation
    getRedis();
    expect(MockRedis).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when no client exists", async () => {
    await closeRedis();
    expect(mockQuit).not.toHaveBeenCalled();
  });
});

describe("getCacheRedis (#1013)", () => {
  it("is the same client as getRedis() when REDIS_CACHE_URL is unset", () => {
    expect(getCacheRedis()).toBe(getRedis());
    expect(MockRedis).toHaveBeenCalledTimes(1);
  });

  it("is the same client when REDIS_CACHE_URL equals REDIS_URL", () => {
    mockEnv.REDIS_CACHE_URL = mockEnv.REDIS_URL;
    expect(getCacheRedis()).toBe(getRedis());
  });

  it("is a separate singleton on REDIS_CACHE_URL when it differs", () => {
    mockEnv.REDIS_CACHE_URL = "redis://cache:6379";
    const cache = getCacheRedis();
    expect(cache).not.toBe(getRedis());
    expect(getCacheRedis()).toBe(cache);
    expect(MockRedis).toHaveBeenCalledWith("redis://cache:6379", {
      lazyConnect: false,
    });
  });

  it("closeRedis quits both clients", async () => {
    mockEnv.REDIS_CACHE_URL = "redis://cache:6379";
    getRedis();
    getCacheRedis();
    await closeRedis();
    expect(mockQuit).toHaveBeenCalledTimes(2);
  });

  it("warns once in production when no cache instance is configured", () => {
    mockEnv.NODE_ENV = "production";
    getRedis();
    getRedis();
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it("does not warn in production when a cache instance is configured", () => {
    mockEnv.NODE_ENV = "production";
    mockEnv.REDIS_CACHE_URL = "redis://cache:6379";
    getRedis();
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
