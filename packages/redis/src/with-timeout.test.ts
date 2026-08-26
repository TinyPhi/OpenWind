import { describe, it, expect, vi } from "vitest";
import { withRedisTimeout } from "./with-timeout.js";

vi.mock("@platform/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

describe("withRedisTimeout", () => {
  it("returns the function's result when it resolves within the timeout", async () => {
    const result = await withRedisTimeout(
      () => Promise.resolve("ok"),
      "fallback",
      {},
    );
    expect(result).toBe("ok");
  });

  it("returns the fallback when the function throws", async () => {
    const result = await withRedisTimeout(
      () => Promise.reject(new Error("boom")),
      "fallback",
      {},
    );
    expect(result).toBe("fallback");
  });

  it("returns the fallback when the function doesn't settle before the timeout", async () => {
    const result = await withRedisTimeout(
      () => new Promise<string>(() => {}), // never resolves
      "fallback",
      {},
      10,
    );
    expect(result).toBe("fallback");
  });
});
