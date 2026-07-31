import { describe, it, expect, vi } from "vitest";
import type { Redis } from "ioredis";
import { checkRateLimit } from "./rate-limit.js";

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function makeRedis(zcardResult: number): Redis {
  const exec = vi.fn().mockResolvedValue([
    [null, "OK"],
    [null, 1],
    [null, zcardResult],
    [null, 1],
  ]);
  const pipeline = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec,
  };
  return { pipeline: vi.fn().mockReturnValue(pipeline) } as unknown as Redis;
}

describe("checkRateLimit", () => {
  it("allows the request when the count is within the limit", async () => {
    const redis = makeRedis(5);
    const result = await checkRateLimit(redis, "rl:test", 10, 60);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
  });

  it("blocks the request once the count exceeds the limit", async () => {
    const redis = makeRedis(11);
    const result = await checkRateLimit(redis, "rl:test", 10, 60);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("pipelines zremrangebyscore, zadd, zcard, expire against the given key", async () => {
    const redis = makeRedis(1);
    await checkRateLimit(redis, "rl:some-key", 10, 60);
    const pipeline = (redis.pipeline as ReturnType<typeof vi.fn>).mock
      .results[0]?.value as {
      zremrangebyscore: ReturnType<typeof vi.fn>;
      zadd: ReturnType<typeof vi.fn>;
      zcard: ReturnType<typeof vi.fn>;
      expire: ReturnType<typeof vi.fn>;
    };
    expect(pipeline.zremrangebyscore).toHaveBeenCalledWith(
      "rl:some-key",
      0,
      expect.any(Number),
    );
    expect(pipeline.zcard).toHaveBeenCalledWith("rl:some-key");
    expect(pipeline.expire).toHaveBeenCalledWith("rl:some-key", 120);
  });

  it("returns remaining=0 (never negative) when count far exceeds the limit", async () => {
    const redis = makeRedis(50);
    const result = await checkRateLimit(redis, "rl:test", 10, 60);
    expect(result.remaining).toBe(0);
  });

  describe("fails open (never throws, bounded time)", () => {
    it("allows the request when the pipeline rejects", async () => {
      const redis = {
        pipeline: vi.fn(() => ({
          zremrangebyscore: vi.fn().mockReturnThis(),
          zadd: vi.fn().mockReturnThis(),
          zcard: vi.fn().mockReturnThis(),
          expire: vi.fn().mockReturnThis(),
          exec: vi.fn().mockRejectedValue(new Error("connection closed")),
        })),
      } as unknown as Redis;

      const result = await checkRateLimit(redis, "rl:test", 10, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10);
    });

    it("allows the request within a bounded time when the pipeline hangs (unreachable Redis)", async () => {
      const redis = {
        pipeline: vi.fn(() => ({
          zremrangebyscore: vi.fn().mockReturnThis(),
          zadd: vi.fn().mockReturnThis(),
          zcard: vi.fn().mockReturnThis(),
          expire: vi.fn().mockReturnThis(),
          exec: vi.fn(() => new Promise(() => {})), // never settles
        })),
      } as unknown as Redis;

      const start = Date.now();
      const result = await checkRateLimit(redis, "rl:test", 10, 60);
      const elapsedMs = Date.now() - start;

      expect(result.allowed).toBe(true);
      // Bounded by the internal timeout, not by the hung pipeline — must not
      // wait anywhere near the test framework's own default timeout.
      expect(elapsedMs).toBeLessThan(2000);
    });
  });
});
