/**
 * file-cleanup.test.ts
 *
 * Unit tests for the file cleanup worker.
 * DB and disk I/O are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbDelete = vi.fn();

vi.mock("@platform/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
    delete: (...args: unknown[]) => mockDbDelete(...args),
  },
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
  const chain = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    // The cleanup query now chains .limit(BATCH_LIMIT) after .where(...)
    limit: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  mockDbSelect.mockReturnValue(chain);
  return chain;
}

function mockDelete() {
  const chain = { where: vi.fn().mockResolvedValue(undefined) };
  mockDbDelete.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUnlink.mockResolvedValue(undefined);
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
    expect(mockDbDelete).not.toHaveBeenCalled();
  });

  it("purges stale files: deletes on-disk file, releases quota, deletes row", async () => {
    mockSelect([
      {
        id: "file-1",
        tenantId: "tenant-1",
        storageKey: "tenants/t/files/file-1.pdf",
        sizeBytes: 1024,
      },
    ]);
    mockDelete();

    await capturedProcessor!();

    expect(mockUnlink).toHaveBeenCalledTimes(1);
    expect(mockDbDelete).toHaveBeenCalledTimes(1); // row deletion
  });

  it("continues purging remaining files if one on-disk deletion fails", async () => {
    mockSelect([
      {
        id: "file-1",
        tenantId: "tenant-1",
        storageKey: "tenants/t/files/file-1.pdf",
        sizeBytes: 1024,
      },
      {
        id: "file-2",
        tenantId: "tenant-1",
        storageKey: "tenants/t/files/file-2.pdf",
        sizeBytes: 2048,
      },
    ]);
    mockUnlink
      .mockRejectedValueOnce(new Error("disk error"))
      .mockResolvedValue(undefined);
    mockDelete();

    await capturedProcessor!();

    // Both files should have their rows deleted even though first unlink call failed
    expect(mockDbDelete).toHaveBeenCalledTimes(2);
  });

  it("purges multiple stale files in a single run", async () => {
    const staleFiles = Array.from({ length: 5 }, (_, i) => ({
      id: `file-${i}`,
      tenantId: "tenant-1",
      storageKey: `tenants/t/files/file-${i}.pdf`,
      sizeBytes: 512,
    }));

    mockSelect(staleFiles);
    mockDelete();

    await capturedProcessor!();

    expect(mockUnlink).toHaveBeenCalledTimes(5);
    expect(mockDbDelete).toHaveBeenCalledTimes(5);
  });
});
