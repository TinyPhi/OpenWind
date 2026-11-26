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
const mockSetRole = vi.fn();
const mockTx = { execute: (...args: unknown[]) => mockExecute(...args) };
vi.mock("@platform/db", () => ({
  db: { transaction: (cb: (tx: unknown) => unknown) => cb(mockTx) },
  setAccessLogRetentionRole: (...args: unknown[]) => mockSetRole(...args),
  setReportingAuditRetentionRole: vi.fn(),
}));

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

vi.mock("./queues.js", () => ({ connection: {} }));
const mockReportingSweep = vi.fn();
vi.mock("./reporting-audit-retention.js", () => ({
  runReportingAuditRetentionSweep: (...args: unknown[]) =>
    mockReportingSweep(...args),
}));

const { runAccessLogRetentionSweep } =
  await import("./access-log-retention.js");

const BATCH_LIMIT = 5000;

function batchResult(deletedCount: number) {
  return [{ deleted_count: deletedCount }];
}

describe("runAccessLogRetentionSweep", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockSetRole.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    mockReportingSweep.mockReset();
    mockReportingSweep.mockResolvedValue(0);
  });

  it("runs every batch after switching to the retention role (#1131)", async () => {
    const order: string[] = [];
    mockSetRole.mockImplementation(() => {
      order.push("role");
    });
    mockExecute.mockImplementationOnce(async () => {
      order.push("sql");
      return batchResult(1);
    });

    await runAccessLogRetentionSweep();

    expect(mockSetRole).toHaveBeenCalledWith(mockTx);
    expect(order).toEqual(["role", "sql"]);
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

  it("warns when it stops at the batch cap with a full last batch", async () => {
    mockExecute.mockResolvedValue(batchResult(BATCH_LIMIT));

    await runAccessLogRetentionSweep();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ maxBatches: 20, batchLimit: BATCH_LIMIT }),
      expect.stringContaining("batch cap"),
    );
  });

  it("does not warn when the last batch was partial", async () => {
    mockExecute.mockResolvedValueOnce(batchResult(BATCH_LIMIT));
    mockExecute.mockResolvedValueOnce(batchResult(3));

    await runAccessLogRetentionSweep();

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("still runs the reporting sweep when an access-log batch throws, and fails the job", async () => {
    mockExecute.mockRejectedValueOnce(new Error("lock timeout"));

    await expect(runAccessLogRetentionSweep()).rejects.toThrow("lock timeout");

    expect(mockReportingSweep).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining("lock timeout") }),
      expect.stringContaining("access-log detail sweep failed"),
    );
  });

  it("logs a reporting sweep failure under its own name, after the access-log sweep finished", async () => {
    mockExecute.mockResolvedValueOnce(batchResult(7));
    mockReportingSweep.mockRejectedValueOnce(new Error("role missing"));

    await expect(runAccessLogRetentionSweep()).rejects.toThrow("role missing");

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ totalDeleted: 7 }),
      expect.stringContaining("sweep complete"),
    );
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining("role missing") }),
      expect.stringContaining("reporting audit sweep failed"),
    );
  });

  it("reports both failures when both sweeps throw", async () => {
    mockExecute.mockRejectedValueOnce(new Error("first"));
    mockReportingSweep.mockRejectedValueOnce(new Error("second"));

    const err: unknown = await runAccessLogRetentionSweep().catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AggregateError);
    expect((err as AggregateError).errors).toHaveLength(2); // narrowed by the instanceof above
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
  });

  it("invokes the sweep when the worker processor runs", async () => {
    mockExecute.mockResolvedValueOnce(batchResult(1));
    expect(capturedProcessor).toBeDefined();

    await capturedProcessor!();

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});
