/**
 * reporting-audit-retention.test.ts
 *
 * Unit tests for the reporting audit retention sweep (#1139, ADR-019 criterion 14).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();
const mockSetRole = vi.fn();
const mockTx = { execute: (...args: unknown[]) => mockExecute(...args) };
vi.mock("@platform/db", () => ({
  db: { transaction: (cb: (tx: unknown) => unknown) => cb(mockTx) },
  setReportingAuditRetentionRole: (...args: unknown[]) => mockSetRole(...args),
}));

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: vi.fn(),
  },
}));

const { runReportingAuditRetentionSweep, REPORTING_RETENTION_BATCH_LIMIT } =
  await import("./reporting-audit-retention.js");

function batchResult(deletedCount: number) {
  return [{ deleted_count: deletedCount }];
}

describe("runReportingAuditRetentionSweep", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockSetRole.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
  });

  it("switches to reporting_audit_retention_role for every batch (#1139)", async () => {
    const order: string[] = [];
    mockSetRole.mockImplementation(() => {
      order.push("role");
    });
    mockExecute.mockImplementationOnce(async () => {
      order.push("sql");
      return batchResult(5);
    });

    const deleted = await runReportingAuditRetentionSweep();

    expect(mockSetRole).toHaveBeenCalledWith(mockTx);
    expect(order).toEqual(["role", "sql"]);
    expect(deleted).toBe(5);
  });

  it("stops after one partial batch", async () => {
    mockExecute.mockResolvedValueOnce(batchResult(25));

    const deleted = await runReportingAuditRetentionSweep();

    expect(deleted).toBe(25);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ totalDeleted: 25, retentionDays: 90 }),
      expect.stringContaining("sweep complete"),
    );
  });

  it("sweeps multiple full batches up to max limit", async () => {
    mockExecute
      .mockResolvedValueOnce(batchResult(REPORTING_RETENTION_BATCH_LIMIT))
      .mockResolvedValueOnce(batchResult(REPORTING_RETENTION_BATCH_LIMIT))
      .mockResolvedValueOnce(batchResult(42));

    const deleted = await runReportingAuditRetentionSweep();

    expect(deleted).toBe(REPORTING_RETENTION_BATCH_LIMIT * 2 + 42);
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("warns when it stops at the batch cap with a full last batch", async () => {
    mockExecute.mockResolvedValue(batchResult(REPORTING_RETENTION_BATCH_LIMIT));

    await runReportingAuditRetentionSweep();

    expect(mockExecute).toHaveBeenCalledTimes(20);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        maxBatches: 20,
        batchLimit: REPORTING_RETENTION_BATCH_LIMIT,
      }),
      expect.stringContaining("batch cap"),
    );
  });

  it("does not warn when the last batch was partial", async () => {
    mockExecute
      .mockResolvedValueOnce(batchResult(REPORTING_RETENTION_BATCH_LIMIT))
      .mockResolvedValueOnce(batchResult(1));

    await runReportingAuditRetentionSweep();

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("honors a custom retentionDays parameter", async () => {
    mockExecute.mockResolvedValueOnce(batchResult(10));

    await runReportingAuditRetentionSweep(30);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 30 }),
      expect.stringContaining("sweep complete"),
    );
  });
});
