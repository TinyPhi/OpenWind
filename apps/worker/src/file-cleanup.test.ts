/**
 * file-cleanup.test.ts
 *
 * Unit tests for the file cleanup worker.
 * DB and disk I/O are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { logger } from "@platform/logger";

// ── Mocks ──────────────────────────────────────────────────────────────────────

let capturedProcessor: (() => Promise<void>) | undefined;

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    processor: () => Promise<void>,
  ) {
    capturedProcessor = processor;
    return {
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock("node:fs/promises", () => ({
  default: {
    unlink: (...args: unknown[]) => mockUnlink(...args),
  },
}));

vi.mock("@platform/files", () => ({
  resolveStoragePath: (storageKey: string) => `/data/files/${storageKey}`,
}));

const mockTenantRows = vi.fn();
const mockWithTenantContext = vi.fn();
const mockTxSelect = vi.fn();
const mockTxDelete = vi.fn();
const fakeTx = {
  select: (...a: unknown[]) => mockTxSelect(...a),
  delete: (...a: unknown[]) => mockTxDelete(...a),
};

vi.mock("@platform/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => mockTenantRows() }) }),
  },
  withTenantContext: (...args: unknown[]) => mockWithTenantContext(...args),
  tenants: { id: "id", trialEndsAt: "trialEndsAt", status: "status" },
  files: {
    id: "id",
    tenantId: "tenantId",
    scanStatus: "scanStatus",
    createdAt: "createdAt",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./queues.js", () => ({
  connection: {},
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockSelect(rows: unknown[]) {
  const chain = { from: vi.fn(), where: vi.fn(), limit: vi.fn() };
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  mockTxSelect.mockReturnValue(chain);
}

function mockDelete() {
  const chain = { where: vi.fn().mockResolvedValue(undefined) };
  mockTxDelete.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUnlink.mockResolvedValue(undefined);
  mockTenantRows.mockResolvedValue([{ id: "tenant-1", trialEndsAt: null }]);
  mockWithTenantContext.mockImplementation(
    (_tenantId: string, fn: (tx: typeof fakeTx) => Promise<unknown>) =>
      fn(fakeTx),
  );
  // Note: capturedProcessor is NOT reset here — Worker() fires once at import
  // time. Clearing it would destroy the only reference we have.
});

await import("./file-cleanup.js");

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("file-cleanup worker", () => {
  it("does nothing when no stale files found", async () => {
    mockSelect([]);

    expect(capturedProcessor).toBeDefined();
    await capturedProcessor!();

    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockTxDelete).not.toHaveBeenCalled();
  });

  it("runs each tenant's work inside withTenantContext (issue #1078)", async () => {
    mockTenantRows.mockResolvedValue([
      { id: "tenant-1", trialEndsAt: null },
      { id: "tenant-2", trialEndsAt: null },
    ]);
    mockSelect([]);

    await capturedProcessor!();

    expect(mockWithTenantContext.mock.calls.map((c) => c[0])).toEqual([
      "tenant-1",
      "tenant-2",
    ]);
  });

  it("purges stale files: deletes on-disk file and the row", async () => {
    mockSelect([
      {
        id: "file-1",
        storageKey: "tenants/t/files/file-1.pdf",
        scanStatus: "pending",
      },
    ]);
    mockDelete();

    await capturedProcessor!();

    expect(mockUnlink).toHaveBeenCalledTimes(1);
    expect(mockTxDelete).toHaveBeenCalledTimes(1);
  });

  it("continues purging remaining files if one on-disk deletion fails", async () => {
    mockSelect([
      { id: "file-1", storageKey: "k/file-1.pdf", scanStatus: "pending" },
      { id: "file-2", storageKey: "k/file-2.pdf", scanStatus: "deleted" },
    ]);
    mockUnlink
      .mockRejectedValueOnce(new Error("disk error"))
      .mockResolvedValue(undefined);
    mockDelete();

    await capturedProcessor!();

    expect(mockTxDelete).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing tenant: logs it and still sweeps the next tenant", async () => {
    mockTenantRows.mockResolvedValue([
      { id: "tenant-bad", trialEndsAt: null },
      { id: "tenant-ok", trialEndsAt: null },
    ]);
    mockWithTenantContext.mockImplementation(
      (tenantId: string, fn: (tx: typeof fakeTx) => Promise<unknown>) =>
        tenantId === "tenant-bad"
          ? Promise.reject(new Error("db error"))
          : fn(fakeTx),
    );
    mockSelect([
      { id: "file-1", storageKey: "k/file-1.pdf", scanStatus: "pending" },
    ]);
    mockDelete();

    await expect(capturedProcessor!()).resolves.toBeUndefined();

    expect(mockTxDelete).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-bad",
        code: "TENANT_SWEEP_FAILED",
      }),
      expect.any(String),
    );
  });
});
