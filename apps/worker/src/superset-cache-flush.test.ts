import { describe, it, expect, vi, beforeEach } from "vitest";
import type Redis from "ioredis";

const { mockAdd, mockWarn, mockEnv } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockWarn: vi.fn(),
  mockEnv: { SUPERSET_REDIS_URL: undefined as string | undefined },
}));
vi.mock("@platform/telemetry", () => ({
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock("@platform/config", () => ({ env: mockEnv }));
vi.mock("@platform/logger", () => ({
  logger: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));
vi.mock("./queues.js", () => ({
  connection: {},
  supersetCacheFlushQueue: { add: mockAdd },
}));

const { flushSupersetCache, enqueueSupersetCacheFlush } =
  await import("./superset-cache-flush.js");

function fakeRedis(pages: Record<string, string[][]>): {
  redis: Redis;
  unlink: ReturnType<typeof vi.fn>;
} {
  const cursors: Record<string, number> = {};
  const scan = vi.fn(async (_cursor: string, _m: string, match: string) => {
    const list = pages[match] ?? [];
    const i = cursors[match] ?? 0;
    cursors[match] = i + 1;
    const keys = list[i] ?? [];
    return [i + 1 < list.length ? String(i + 1) : "0", keys] as [
      string,
      string[],
    ];
  });
  const unlink = vi.fn(async (...keys: string[]) => keys.length);
  // Only scan and unlink are exercised.
  return { redis: { scan, unlink } as unknown as Redis, unlink };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.SUPERSET_REDIS_URL = "redis://redis:6379/2";
});

describe("flushSupersetCache", () => {
  it("scans both Superset prefixes across pages and unlinks what it finds", async () => {
    const { redis, unlink } = fakeRedis({
      "superset_*": [["superset_a", "superset_b"], ["superset_c"]],
      "superset_data_*": [["superset_data_x"]],
    });
    expect(await flushSupersetCache(redis)).toBe(4);
    expect(unlink).toHaveBeenCalledTimes(3);
  });

  it("unlinks nothing when no key matches", async () => {
    const { redis, unlink } = fakeRedis({});
    expect(await flushSupersetCache(redis)).toBe(0);
    expect(unlink).not.toHaveBeenCalled();
  });
});

describe("enqueueSupersetCacheFlush", () => {
  it("is off when SUPERSET_REDIS_URL is unset", async () => {
    mockEnv.SUPERSET_REDIS_URL = undefined;
    expect(await enqueueSupersetCacheFlush("t1", "tenant_purged")).toBe(false);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("queues the tenant and reason, and never throws when the queue is down", async () => {
    expect(await enqueueSupersetCacheFlush("t1", "tenant_purged")).toBe(true);
    expect(mockAdd).toHaveBeenCalledWith(
      "flush",
      { tenantId: "t1", reason: "tenant_purged" },
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    mockAdd.mockRejectedValueOnce(new Error("down"));
    await expect(
      enqueueSupersetCacheFlush("t1", "tenant_purged"),
    ).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
