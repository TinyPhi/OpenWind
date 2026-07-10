import { describe, it, expect, vi, beforeEach } from "vitest";

// ── In-memory pub/sub simulator ────────────────────────────────────────────────
// Lets tests prove cross-"instance" invalidation without a real Redis: publish()
// on the main client synchronously invokes any subscriber's "message" handlers,
// mirroring how two separate API processes would each get the message.

type MessageHandler = (channel: string, message: string) => void;

function makeFakeRedisCluster() {
  const messageHandlers = new Set<MessageHandler>();
  let status = "ready";

  const mainClient = {
    get status() {
      return status;
    },
    publish: vi.fn((channel: string, message: string) => {
      for (const handler of messageHandlers) handler(channel, message);
      return Promise.resolve(1);
    }),
    duplicate: vi.fn(() => makeSubscriber()),
  };

  function makeSubscriber() {
    const errorHandlers: ((err: unknown) => void)[] = [];
    return {
      on: vi.fn(
        (event: string, handler: MessageHandler | ((err: unknown) => void)) => {
          if (event === "message")
            messageHandlers.add(handler as MessageHandler);
          if (event === "error")
            errorHandlers.push(handler as (err: unknown) => void);
        },
      ),
      subscribe: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
    };
  }

  return { mainClient, setStatus: (s: string) => (status = s) };
}

let fakeCluster: ReturnType<typeof makeFakeRedisCluster>;

vi.mock("@platform/redis", () => ({
  getRedis: () => fakeCluster.mainClient,
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  fakeCluster = makeFakeRedisCluster();
});

describe("tenant status cache", () => {
  it("returns undefined for an uncached tenant", async () => {
    const { getCachedTenantStatus } = await import("./tenant-status-cache.js");
    expect(getCachedTenantStatus("t-1")).toBeUndefined();
  });

  it("returns the cached status after set", async () => {
    const { getCachedTenantStatus, setCachedTenantStatus } =
      await import("./tenant-status-cache.js");
    setCachedTenantStatus("t-1", "active");
    expect(getCachedTenantStatus("t-1")).toBe("active");
  });

  it("expires the cached status after the TTL", async () => {
    vi.useFakeTimers();
    const { getCachedTenantStatus, setCachedTenantStatus } =
      await import("./tenant-status-cache.js");
    setCachedTenantStatus("t-1", "active");
    vi.advanceTimersByTime(30_001);
    expect(getCachedTenantStatus("t-1")).toBeUndefined();
    vi.useRealTimers();
  });

  it("invalidateTenantStatusCache clears the local cache immediately", async () => {
    const {
      getCachedTenantStatus,
      setCachedTenantStatus,
      invalidateTenantStatusCache,
    } = await import("./tenant-status-cache.js");
    setCachedTenantStatus("t-1", "active");
    invalidateTenantStatusCache("t-1");
    expect(getCachedTenantStatus("t-1")).toBeUndefined();
  });

  it("invalidateTenantStatusCache publishes to the invalidation channel when redis is ready", async () => {
    const { invalidateTenantStatusCache } =
      await import("./tenant-status-cache.js");
    invalidateTenantStatusCache("t-1");
    expect(fakeCluster.mainClient.publish).toHaveBeenCalledWith(
      "tenant-status:invalidate",
      "t-1",
    );
  });

  it("skips publishing when redis is not ready (no throw, local invalidation still works)", async () => {
    fakeCluster.setStatus("connecting");
    const {
      getCachedTenantStatus,
      setCachedTenantStatus,
      invalidateTenantStatusCache,
    } = await import("./tenant-status-cache.js");
    setCachedTenantStatus("t-1", "active");

    expect(() => invalidateTenantStatusCache("t-1")).not.toThrow();
    expect(getCachedTenantStatus("t-1")).toBeUndefined();
    expect(fakeCluster.mainClient.publish).not.toHaveBeenCalled();
  });

  it("cross-instance: a second process's cache is cleared when this process invalidates and publishes", async () => {
    // Simulates two API replicas sharing one Redis: "instance A" imports the
    // module fresh (its own local _cache + its own subscriber, since
    // vi.resetModules() gives each dynamic import a fresh module instance),
    // subscribes, then "instance B" (this test's own top-level import)
    // invalidates -- instance A's local cache must clear via the pub/sub
    // message, not just instance B's.
    const instanceB = await import("./tenant-status-cache.js");
    instanceB.setCachedTenantStatus("t-1", "active");

    vi.resetModules();
    const instanceA = await import("./tenant-status-cache.js");
    instanceA.setCachedTenantStatus("t-1", "active");
    instanceA.startTenantStatusInvalidationSubscriber();

    instanceB.invalidateTenantStatusCache("t-1");

    expect(instanceA.getCachedTenantStatus("t-1")).toBeUndefined();
  });

  it("startTenantStatusInvalidationSubscriber is idempotent (second call is a no-op)", async () => {
    const { startTenantStatusInvalidationSubscriber } =
      await import("./tenant-status-cache.js");
    startTenantStatusInvalidationSubscriber();
    startTenantStatusInvalidationSubscriber();
    expect(fakeCluster.mainClient.duplicate).toHaveBeenCalledTimes(1);
  });

  it("stopTenantStatusInvalidationSubscriber quits the subscriber connection", async () => {
    const {
      startTenantStatusInvalidationSubscriber,
      stopTenantStatusInvalidationSubscriber,
    } = await import("./tenant-status-cache.js");
    startTenantStatusInvalidationSubscriber();
    const subscriber = fakeCluster.mainClient.duplicate.mock.results[0]
      ?.value as { quit: () => Promise<void> };

    await stopTenantStatusInvalidationSubscriber();

    expect(subscriber.quit).toHaveBeenCalled();
  });
});
