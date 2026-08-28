/**
 * attachment-cleanup.test.ts
 *
 * Unit tests for the attachment-cleanup worker processor.
 * DB is fully mocked -- the real-Postgres path (RLS, tenant isolation) is
 * covered by apps/api/tests/isolation/third-party-attachments-presign-upload.isolation.test.ts,
 * this file only exercises the sweep logic itself.
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

const mockDbSelect = vi.fn();
const mockDbUpdate = vi.fn();
const mockDbDelete = vi.fn();

vi.mock("@platform/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
    delete: (...args: unknown[]) => mockDbDelete(...args),
  },
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
  const chain = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  mockDbSelect.mockReturnValue(chain);
  return chain;
}

function mockUpdate() {
  const chain = {
    set: vi.fn(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  chain.set.mockReturnValue(chain);
  mockDbUpdate.mockReturnValue(chain);
  return chain;
}

function mockDelete(rows: { id: string }[] = []) {
  const chain = {
    where: vi.fn(),
    returning: vi.fn(),
  };
  chain.where.mockReturnValue(chain);
  chain.returning.mockResolvedValue(rows);
  mockDbDelete.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

await import("./attachment-cleanup.js");

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("attachment-cleanup worker", () => {
  it("does nothing in the expire pass when no stale slots found", async () => {
    mockSelect([]);
    mockDelete([]);

    await capturedProcessor!();

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("expires a stale slot conditionally on its status still being pending/uploading — PR #472 review finding 3", async () => {
    mockSelect([{ id: "attachment-1", tenantId: "tenant-1" }]);
    const updateChain = mockUpdate();
    mockDelete([]);

    await capturedProcessor!();

    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired" }),
    );
    // The where() clause must re-check status (not just filter by id) so a
    // slot that completed its upload between the SELECT above and this
    // UPDATE can't be clobbered back to "expired" — asserting the drizzle
    // `and(...)` condition tree references the status operand.
    const whereArg = updateChain.where.mock.calls[0]?.[0];
    expect(whereArg).toBeDefined();
    const serialized = JSON.stringify(whereArg);
    expect(serialized).toContain("status");
    expect(serialized).toContain("tenantId");
  });

  it("continues processing remaining slots if one update fails", async () => {
    mockSelect([
      { id: "attachment-1", tenantId: "tenant-1" },
      { id: "attachment-2", tenantId: "tenant-1" },
    ]);
    const chain = {
      set: vi.fn(),
      where: vi
        .fn()
        .mockRejectedValueOnce(new Error("db error"))
        .mockResolvedValueOnce(undefined),
    };
    chain.set.mockReturnValue(chain);
    mockDbUpdate.mockReturnValue(chain);
    mockDelete([]);

    await capturedProcessor!();

    expect(chain.where).toHaveBeenCalledTimes(2);
  });

  it("hard-deletes rows past their expired grace period in a delete pass separate from the expire pass", async () => {
    mockSelect([]);
    mockDelete([{ id: "attach-old-1" }, { id: "attach-old-2" }]);

    await capturedProcessor!();

    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbDelete).toHaveBeenCalledTimes(1);
  });
});
