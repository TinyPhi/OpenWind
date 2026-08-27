/**
 * access-log-retention.test.ts
 *
 * Unit tests for the sweep's batching/loop-termination logic. DB is fully
 * mocked (db.execute returns canned deleted_count rows) -- the real-Postgres
 * path (the actual aggregate-then-delete SQL, RLS) is out of scope for a
 * unit test; a real run against Postgres is exercised manually/in CI via
 * the isolation suite once one exists for this sweep.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedProcessor: (() => Promise<void>) | undefined;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: () => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockExecute = vi.fn();
vi.mock("@platform/db", () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
}));

const mockLoggerInfo = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: vi.fn(),
  },
}));

vi.mock("./queues.js", () => ({ connection: {} }));

const { runAccessLogRetentionSweep } =
  await import("./access-log-retention.js");

const BATCH_LIMIT = 5000;

function batchResult(deletedCount: number) {
  return [{ deleted_count: deletedCount }];
}

describe("runAccessLogRetentionSweep", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockLoggerInfo.mockReset();
  });

  it("stops after one batch when the batch is smaller than the limit", async () => {
    mockExecute.mockResolvedValueOnce(batchResult(42));

    await runAccessLogRetentionSweep();

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ totalDeleted: 42 }),
      expect.stringContaining("sweep complete"),
    );
  });

  it("keeps running full-size batches and sums the total", async () => {
    mockExecute
      .mockResolvedValueOnce(batchResult(BATCH_LIMIT))
      .mockResolvedValueOnce(batchResult(BATCH_LIMIT))
      .mockResolvedValueOnce(batchResult(10));

    await runAccessLogRetentionSweep();

    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ totalDeleted: BATCH_LIMIT * 2 + 10 }),
      expect.stringContaining("sweep complete"),
    );
  });

  it("caps at MAX_BATCHES_PER_RUN even if every batch stays full", async () => {
    mockExecute.mockResolvedValue(batchResult(BATCH_LIMIT));

    await runAccessLogRetentionSweep();

    expect(mockExecute).toHaveBeenCalledTimes(20);
  });

  it("treats a run with nothing to sweep as zero deleted, no error", async () => {
    mockExecute.mockResolvedValueOnce(batchResult(0));

    await runAccessLogRetentionSweep();

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ totalDeleted: 0 }),
      expect.stringContaining("sweep complete"),
    );
  });

  it("invokes the sweep when the worker processor runs", async () => {
    mockExecute.mockResolvedValueOnce(batchResult(1));
    expect(capturedProcessor).toBeDefined();

    await capturedProcessor!();

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
