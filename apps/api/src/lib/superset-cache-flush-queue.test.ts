import type * as RedisModule from "@platform/redis";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAdd, mockWarn, mockInfo, mockEnv, mockReadSelfcheck } = vi.hoisted(
  () => ({
    mockAdd: vi.fn(),
    mockWarn: vi.fn(),
    mockInfo: vi.fn(),
    mockReadSelfcheck: vi.fn(),
    mockEnv: {
      SUPERSET_REDIS_URL: undefined as string | undefined,
      SUPERSET_OAUTH_CLIENT_ID: undefined as string | undefined,
      SUPERSET_DEPLOYMENT: "on" as "on" | "off",
      SUPERSET_SELFCHECK_TTL_MINUTES: 30,
    },
  }),
);
vi.mock("@platform/telemetry", () => ({
  Queue: class {
    add = mockAdd;
  },
}));
vi.mock("@platform/config", () => ({
  env: mockEnv,
  supersetErasureMode: (e: typeof mockEnv): string =>
    e.SUPERSET_DEPLOYMENT === "off"
      ? "off"
      : e.SUPERSET_OAUTH_CLIENT_ID
        ? "full"
        : "cache-only",
}));
vi.mock("@platform/logger", () => ({
  logger: { info: mockInfo, warn: mockWarn },
}));
vi.mock("@platform/redis", async () => {
  const real = await vi.importActual<typeof RedisModule>("@platform/redis");
  return {
    readSupersetSelfcheck: mockReadSelfcheck,
    resolveSupersetErasureMode: real.resolveSupersetErasureMode,
  };
});
vi.mock("./redis.js", () => ({ connection: {} }));

const { enqueueSupersetCacheFlush } =
  await import("./superset-cache-flush-queue.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.SUPERSET_REDIS_URL = "redis://redis:6379/2";
  mockEnv.SUPERSET_OAUTH_CLIENT_ID = undefined;
  mockEnv.SUPERSET_DEPLOYMENT = "on";
  mockReadSelfcheck.mockResolvedValue(null);
});

describe("enqueueSupersetCacheFlush", () => {
  it("queues nothing, and logs, with SUPERSET_DEPLOYMENT=off and no report from Superset (#728, D8)", async () => {
    mockEnv.SUPERSET_DEPLOYMENT = "off";
    expect(await enqueueSupersetCacheFlush("t1", "user_erased")).toBe(false);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "t1" }),
      expect.stringContaining("SUPERSET_DEPLOYMENT is off"),
    );
  });

  it("still flushes with the flag off when Superset reports Stage 2 on (#1137)", async () => {
    mockEnv.SUPERSET_DEPLOYMENT = "off";
    mockReadSelfcheck.mockResolvedValue({
      checkedAt: Date.now(),
      outcome: "mismatch",
      stage2: true,
      mismatch: true,
    });
    expect(await enqueueSupersetCacheFlush("t1", "user_erased")).toBe(true);
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });

  it("flushes with the flag on, with or without Stage 2", async () => {
    expect(await enqueueSupersetCacheFlush("t1", "user_erased")).toBe(true);
    mockEnv.SUPERSET_OAUTH_CLIENT_ID = "client-id";
    expect(await enqueueSupersetCacheFlush("t1", "user_erased")).toBe(true);
    expect(mockAdd).toHaveBeenCalledTimes(2);
  });

  it("queues nothing when SUPERSET_REDIS_URL is unset", async () => {
    mockEnv.SUPERSET_REDIS_URL = undefined;
    expect(await enqueueSupersetCacheFlush("t1", "user_erased")).toBe(false);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it("queues a job carrying the tenant and reason but no user id", async () => {
    expect(await enqueueSupersetCacheFlush("t1", "user_erased")).toBe(true);
    expect(mockAdd).toHaveBeenCalledWith(
      "flush",
      { tenantId: "t1", reason: "user_erased" },
      { jobId: expect.stringMatching(/^superset-cache-flush-\d+$/) },
    );
  });

  it("uses one job id for requests in the same window, so a burst shares one flush", async () => {
    await enqueueSupersetCacheFlush("t1", "user_erased");
    await enqueueSupersetCacheFlush("t2", "user_erased");
    const ids = mockAdd.mock.calls.map(
      (c) => (c[2] as { jobId: string }).jobId,
    );
    expect(ids[0]).toBe(ids[1]);
  });

  it("swallows a queue failure, logs it and reports false", async () => {
    mockAdd.mockRejectedValueOnce(new Error("redis down"));
    await expect(
      enqueueSupersetCacheFlush("t1", "tenant_purged"),
    ).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
