/**
 * attachment-cleanup.test.ts
 *
 * Unit tests for the attachment cleanup worker. DB is fully mocked, same
 * pattern as file-cleanup.test.ts.
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

vi.mock("@platform/db", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    update: (...args: unknown[]) => mockDbUpdate(...args),
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

beforeEach(() => {
  vi.clearAllMocks();
});

await import("./attachment-cleanup.js");

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("attachment-cleanup worker", () => {
  it("does nothing when no stale slots found", async () => {
    mockSelect([]);

    expect(capturedProcessor).toBeDefined();
    await capturedProcessor!();

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("expires a stale slot conditionally on its status still being pending/uploading — PR #472 review finding 3", async () => {
    mockSelect([{ id: "attachment-1", tenantId: "tenant-1" }]);
    const updateChain = mockUpdate();

    await capturedProcessor!();

    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "expired" }),
    );
    // The where() clause must re-check status (not just filter by id) so a
    // slot that completed its upload between the SELECT above and this
    // UPDATE can't be clobbered back to "expired" — asserting the drizzle
    // `and(...)` condition tree references the id, tenant, and inArray
    // status-check operands (via their stringified SQL) rather than a bare
    // eq(id) alone.
    const whereArg = updateChain.where.mock.calls[0]?.[0];
    expect(whereArg).toBeDefined();
    const serialized = JSON.stringify(whereArg);
    expect(serialized).toContain("status");
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

    await capturedProcessor!();

    expect(chain.where).toHaveBeenCalledTimes(2);
  });
});
