import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAdd, mockWarn, mockEnv } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockWarn: vi.fn(),
  mockEnv: { SUPERSET_REDIS_URL: undefined as string | undefined },
}));
vi.mock("@platform/telemetry", () => ({
  Queue: class {
    add = mockAdd;
  },
}));
vi.mock("@platform/config", () => ({ env: mockEnv }));
vi.mock("@platform/logger", () => ({ logger: { warn: mockWarn } }));
vi.mock("./redis.js", () => ({ connection: {} }));

const { enqueueSupersetCacheFlush } =
  await import("./superset-cache-flush-queue.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.SUPERSET_REDIS_URL = "redis://redis:6379/2";
});

describe("enqueueSupersetCacheFlush", () => {
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
