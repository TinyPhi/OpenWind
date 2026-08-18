import { describe, it, expect, vi } from "vitest";
import {
  applyQueryGovernor,
  checkRowCeiling,
  withJobTimeout,
  DEFAULT_QUERY_TIMEOUT_MS,
} from "./plugin-governor.js";

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("applyQueryGovernor", () => {
  it("issues a SET LOCAL statement_timeout with the given value", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const tx = { execute } as unknown as Parameters<
      typeof applyQueryGovernor
    >[0];
    await applyQueryGovernor(tx, 1234);
    expect(execute).toHaveBeenCalledTimes(1);
    // drizzle-orm's sql`` template returns a structured SQL object, not a
    // plain string — inspect its queryChunks rather than stringifying it.
    const queryArg = execute.mock.calls[0]?.[0] as {
      queryChunks: Array<{ value?: string[] } | number>;
    };
    expect(queryArg.queryChunks[0]).toMatchObject({
      value: [expect.stringContaining("SET LOCAL statement_timeout")],
    });
    expect(queryArg.queryChunks).toContain(1234);
  });

  it("defaults to DEFAULT_QUERY_TIMEOUT_MS when no timeout is given", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const tx = { execute } as unknown as Parameters<
      typeof applyQueryGovernor
    >[0];
    await applyQueryGovernor(tx);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(DEFAULT_QUERY_TIMEOUT_MS).toBe(5_000);
  });
});

describe("checkRowCeiling", () => {
  it("returns null when the row count is within the ceiling", async () => {
    expect(await checkRowCeiling(100, 10_000)).toBeNull();
  });

  it("returns a breach detail when the row count exceeds the ceiling", async () => {
    const result = await checkRowCeiling(10_001, 10_000);
    expect(result).toEqual({ rowCount: 10_001, ceiling: 10_000 });
  });

  it("treats exactly the ceiling as not breached", async () => {
    expect(await checkRowCeiling(10_000, 10_000)).toBeNull();
  });
});

describe("withJobTimeout", () => {
  it("resolves normally when the job finishes before the timeout", async () => {
    const onBreach = vi.fn();
    const result = await withJobTimeout(
      () => new Promise((resolve) => setTimeout(() => resolve("done"), 10)),
      { timeoutMs: 1000, onBreach },
    );
    expect(result).toBe("done");
    expect(onBreach).not.toHaveBeenCalled();
  });

  it("fires onBreach but still lets the job finish and resolve", async () => {
    const onBreach = vi.fn();
    const result = await withJobTimeout(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve("finished late"), 50),
        ),
      { timeoutMs: 10, onBreach },
    );
    expect(result).toBe("finished late");
    expect(onBreach).toHaveBeenCalledTimes(1);
  });

  it("propagates a rejection from the job even after a breach fired", async () => {
    const onBreach = vi.fn();
    await expect(
      withJobTimeout(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("job failed")), 30),
          ),
        { timeoutMs: 5, onBreach },
      ),
    ).rejects.toThrow("job failed");
    expect(onBreach).toHaveBeenCalledTimes(1);
  });
});
