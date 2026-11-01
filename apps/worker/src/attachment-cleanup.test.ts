/**
 * attachment-cleanup.test.ts
 *
 * Unit tests for the attachment-cleanup worker processor.
 * DB is fully mocked -- the real-Postgres path (RLS, tenant isolation) is
 * covered by apps/api/tests/isolation/third-party-attachments-presign-upload.isolation.test.ts,
 * this file only exercises the sweep logic itself.
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

const mockTenantRows = vi.fn();
const mockWithTenantContext = vi.fn();
const mockTxSelect = vi.fn();
const mockTxUpdate = vi.fn();
const mockTxDelete = vi.fn();
const fakeTx = {
  select: (...a: unknown[]) => mockTxSelect(...a),
  update: (...a: unknown[]) => mockTxUpdate(...a),
  delete: (...a: unknown[]) => mockTxDelete(...a),
};

vi.mock("@platform/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => mockTenantRows() }) }),
  },
  withTenantContext: (...args: unknown[]) => mockWithTenantContext(...args),
  tenants: { id: "id", trialEndsAt: "trialEndsAt", status: "status" },
  attachments: {
    id: "id",
    tenantId: "tenantId",
    status: "status",
    uploadExpiresAt: "uploadExpiresAt",
    updatedAt: "updatedAt",
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

function mockUpdate(rows: { id: string }[] = []) {
  const chain = { set: vi.fn(), where: vi.fn(), returning: vi.fn() };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.returning.mockResolvedValue(rows);
  mockTxUpdate.mockReturnValue(chain);
  return chain;
}

function mockDelete(rows: { id: string }[] = []) {
  const chain = { where: vi.fn(), returning: vi.fn() };
  chain.where.mockReturnValue(chain);
  chain.returning.mockResolvedValue(rows);
  mockTxDelete.mockReturnValue(chain);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantRows.mockResolvedValue([{ id: "tenant-1", trialEndsAt: null }]);
  mockWithTenantContext.mockImplementation(
    (_tenantId: string, fn: (tx: typeof fakeTx) => Promise<unknown>) =>
      fn(fakeTx),
  );
});

await import("./attachment-cleanup.js");

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("attachment-cleanup worker", () => {
  it("runs each tenant's sweep inside withTenantContext (issue #1078)", async () => {
    mockTenantRows.mockResolvedValue([
      { id: "tenant-1", trialEndsAt: null },
      { id: "tenant-2", trialEndsAt: null },
    ]);
    mockSelect([]);
    mockDelete([]);

    await capturedProcessor!();

    expect(mockWithTenantContext.mock.calls.map((c) => c[0])).toEqual([
      "tenant-1",
      "tenant-2",
    ]);
  });

  it("does nothing in the expire pass when no stale slots found", async () => {
    mockSelect([]);
    mockDelete([]);

    await capturedProcessor!();

    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it("expires a stale slot conditionally on its status still being pending/uploading — PR #472 review finding 3", async () => {
    mockSelect([{ id: "attachment-1" }]);
    const updateChain = mockUpdate([{ id: "attachment-1" }]);
    mockDelete([]);

    await capturedProcessor!();

    expect(mockTxUpdate).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired" }),
    );
    const serialized = JSON.stringify(updateChain.where.mock.calls[0]?.[0]);
    expect(serialized).toContain("status");
    expect(serialized).toContain("tenantId");
  });

  it("hard-deletes rows past their expired grace period even when nothing newly expired", async () => {
    mockSelect([]);
    mockDelete([{ id: "attach-old-1" }, { id: "attach-old-2" }]);

    await capturedProcessor!();

    expect(mockTxUpdate).not.toHaveBeenCalled();
    expect(mockTxDelete).toHaveBeenCalledTimes(1);
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
    mockSelect([]);
    mockDelete([{ id: "x" }]);

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
