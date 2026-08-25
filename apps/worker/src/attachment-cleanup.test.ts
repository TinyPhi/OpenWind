/**
 * attachment-cleanup.test.ts
 *
 * Unit tests for the attachment-cleanup worker processor.
 * DB is fully mocked -- the real-Postgres path (RLS, tenant isolation) is
 * covered by apps/api/tests/isolation/third-party-attachments-presign-upload.isolation.test.ts,
 * this file only exercises the sweep logic itself.
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

const mockSelectResult = { rows: [] as { id: string; tenantId: string }[] };
const mockDbUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
});
const mockDeleteResult = { rows: [] as { id: string }[] };
const mockDbDelete = vi.fn().mockReturnValue({
  where: vi.fn().mockReturnValue({
    returning: vi
      .fn()
      .mockImplementation(() => Promise.resolve(mockDeleteResult.rows)),
  }),
});

vi.mock("@platform/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi
            .fn()
            .mockImplementation(() => Promise.resolve(mockSelectResult.rows)),
        }),
      }),
    }),
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

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectResult.rows = [];
  mockDeleteResult.rows = [];
});

describe("attachment-cleanup", () => {
  it("does nothing when no stale slots are found", async () => {
    await import("./attachment-cleanup.js");
    mockSelectResult.rows = [];
    await capturedProcessor!();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("marks each stale slot as expired", async () => {
    await import("./attachment-cleanup.js");
    mockSelectResult.rows = [
      { id: "attach-1", tenantId: "tenant-1" },
      { id: "attach-2", tenantId: "tenant-1" },
    ];
    await capturedProcessor!();
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);
  });

  it("continues past a per-row failure and still processes the rest", async () => {
    await import("./attachment-cleanup.js");
    mockDbUpdate
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error("db error")),
        }),
      })
      .mockReturnValueOnce({
        set: vi
          .fn()
          .mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      });
    mockSelectResult.rows = [
      { id: "attach-1", tenantId: "tenant-1" },
      { id: "attach-2", tenantId: "tenant-1" },
    ];
    await expect(capturedProcessor!()).resolves.toBeUndefined();
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);
  });

  it("hard-deletes rows past their expired grace period, in a delete pass separate from the expire pass", async () => {
    await import("./attachment-cleanup.js");
    mockSelectResult.rows = [];
    mockDeleteResult.rows = [{ id: "attach-old-1" }, { id: "attach-old-2" }];

    await capturedProcessor!();

    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockDbDelete).toHaveBeenCalledTimes(1);
  });
});
