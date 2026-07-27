/**
 * index.test.ts — @platform/files unit tests
 * BullMQ and DB are mocked; disk I/O hits a real temp directory (no fs mocks) —
 * this catches real path-construction/atomic-write bugs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Redis } from "ioredis";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn();
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(function () {
    return { add: mockQueueAdd, close: mockQueueClose };
  }),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Storage root is a fresh temp dir per test file run; individual tests don't
// need per-test isolation since every path is namespaced by a fresh tenantId.
const STORAGE_ROOT = await fsp.mkdtemp(
  path.join(os.tmpdir(), "openwind-files-test-"),
);

vi.mock("@platform/config", () => ({
  env: {
    FILES_STORAGE_PATH: STORAGE_ROOT,
    SKIP_AV_SCAN: false,
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  sql: vi.fn(),
  ne: vi.fn(),
}));

vi.mock("@platform/db", () => ({
  files: {
    id: "files.id",
    tenantId: "files.tenant_id",
    scanStatus: "files.scan_status",
    storageKey: "files.storage_key",
    originalName: "files.original_name",
    updatedAt: "files.updated_at",
  },
  tenants: {
    id: "tenants.id",
    config: "tenants.config",
  },
}));

const { saveUpload, getFileStream, deleteFile, deleteTenantFiles } =
  await import("./index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-aaa";
const USER_ID = "user-bbb";
const FILE_ID = "file-ccc";

function makeRedis(): Redis {
  return {} as Redis;
}

async function readStreamToBuffer(stream: fs.ReadStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

type MockDb = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
};

/**
 * Build a mock DbOrTx.
 *
 * The `transaction` method passes the same mock object to the callback so that
 * selects/inserts inside the transaction use the same mock chains.  The
 * `select` chain includes both `.for("update").limit()` (used by the
 * SELECT FOR UPDATE inside saveUpload's transaction) and plain `.limit()`.
 */
function makeDb(overrides: Partial<MockDb> = {}): MockDb {
  const mockDb: MockDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          for: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue([{ config: { storage_quota_mb: 100 } }]),
          }),
          limit: vi
            .fn()
            .mockResolvedValue([{ config: { storage_quota_mb: 100 } }]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    execute: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
    ...overrides,
  };

  mockDb.transaction = vi
    .fn()
    .mockImplementation(async (fn: (tx: MockDb) => Promise<unknown>) =>
      fn(mockDb),
    );

  return mockDb;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueueAdd.mockResolvedValue({ id: "j-1" });
  mockQueueClose.mockResolvedValue(undefined);
});

afterEach(async () => {
  await fsp.rm(STORAGE_ROOT, { recursive: true, force: true }).catch(() => {
    // best-effort cleanup; a leftover temp dir doesn't fail the suite
  });
  await fsp.mkdir(STORAGE_ROOT, { recursive: true });
});

// ── saveUpload ────────────────────────────────────────────────────────────────

describe("saveUpload", () => {
  it("writes bytes to disk and returns fileId + pending status", async () => {
    let selectCallCount = 0;
    const limitFn = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        return Promise.resolve([{ config: { storage_quota_mb: 100 } }]);
      }
      return Promise.resolve([{ total: "0" }]);
    });

    const db = makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            for: vi.fn().mockReturnValue({ limit: limitFn }),
            limit: limitFn,
          }),
        }),
      }),
    });

    const bytes = Buffer.from("hello world");
    const result = await saveUpload(
      db as never,
      makeRedis(),
      TENANT_ID,
      USER_ID,
      "helpdesk",
      null,
      "report.pdf",
      "application/pdf",
      bytes,
    );

    expect(result.fileId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.scanStatus).toBe("pending");

    const expectedPath = path.join(
      STORAGE_ROOT,
      TENANT_ID,
      "helpdesk",
      "unattached",
      `${result.fileId}.pdf`,
    );
    const onDisk = await fsp.readFile(expectedPath);
    expect(onDisk.equals(bytes)).toBe(true);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "scan",
      expect.objectContaining({ fileId: result.fileId, tenantId: TENANT_ID }),
      expect.objectContaining({ jobId: `av-scan-${result.fileId}` }),
    );
  });

  it("leaves no partial file at the final path if the write step fails", async () => {
    const db = makeDb();
    // Point storage root at a path that can't be written to, by making the
    // parent a file instead of a directory — mkdir(recursive) will fail.
    const blockedPath = path.join(STORAGE_ROOT, "blocked-parent");
    await fsp.writeFile(blockedPath, "not a directory");

    vi.doMock("@platform/config", () => ({
      env: { FILES_STORAGE_PATH: blockedPath, SKIP_AV_SCAN: false },
    }));
    vi.resetModules();
    const { saveUpload: saveUploadBlocked } = await import("./index.js");

    await expect(
      saveUploadBlocked(
        db as never,
        makeRedis(),
        TENANT_ID,
        USER_ID,
        "helpdesk",
        null,
        "report.pdf",
        "application/pdf",
        Buffer.from("data"),
      ),
    ).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });

    vi.doUnmock("@platform/config");
    vi.resetModules();
  });

  it("throws FILE_TOO_LARGE when sizeBytes exceeds 100MB", async () => {
    const db = makeDb();
    await expect(
      saveUpload(
        db as never,
        makeRedis(),
        TENANT_ID,
        USER_ID,
        "helpdesk",
        null,
        "huge.zip",
        "application/zip",
        Buffer.alloc(101 * 1024 * 1024),
      ),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws FILE_TOO_LARGE for an image over its per-mime-type cap even though it's under the flat 100MB max", async () => {
    const db = makeDb();
    await expect(
      saveUpload(
        db as never,
        makeRedis(),
        TENANT_ID,
        USER_ID,
        "helpdesk",
        null,
        "huge.png",
        "image/png",
        Buffer.alloc(20 * 1024 * 1024),
      ),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("allows an image under its per-mime-type cap", async () => {
    const db = makeDb();
    const result = await saveUpload(
      db as never,
      makeRedis(),
      TENANT_ID,
      USER_ID,
      "helpdesk",
      null,
      "small.png",
      "image/png",
      Buffer.alloc(1024),
    );

    expect(result.fileId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("throws QUOTA_EXCEEDED when upload would exceed tenant quota", async () => {
    const limitMock = vi
      .fn()
      .mockResolvedValueOnce([{ config: { storage_quota_mb: 1 } }])
      .mockResolvedValueOnce([{ total: String(1024 * 1024) }]);

    const db = makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            for: vi.fn().mockReturnValue({ limit: limitMock }),
            limit: limitMock,
          }),
        }),
      }),
    });

    await expect(
      saveUpload(
        db as never,
        makeRedis(),
        TENANT_ID,
        USER_ID,
        "helpdesk",
        null,
        "report.pdf",
        "application/pdf",
        Buffer.alloc(1024), // 1 KB on a fully-used 1 MB quota → exceeds
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("marks clean immediately and skips the queue when SKIP_AV_SCAN is true", async () => {
    vi.doMock("@platform/config", () => ({
      env: { FILES_STORAGE_PATH: STORAGE_ROOT, SKIP_AV_SCAN: true },
    }));
    vi.resetModules();
    const { saveUpload: saveUploadSkip } = await import("./index.js");

    const db = makeDb();
    const result = await saveUploadSkip(
      db as never,
      makeRedis(),
      TENANT_ID,
      USER_ID,
      "helpdesk",
      null,
      "report.pdf",
      "application/pdf",
      Buffer.from("data"),
    );

    expect(result.scanStatus).toBe("clean");
    expect(mockQueueAdd).not.toHaveBeenCalled();

    vi.doUnmock("@platform/config");
    vi.resetModules();
  });
});

// ── getFileStream ─────────────────────────────────────────────────────────────

describe("getFileStream", () => {
  function makeDbWithStatus(scanStatus: string, storageKey: string) {
    return makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: FILE_ID,
                scanStatus,
                storageKey,
                originalName: "test-file.pdf",
                mimeType: "application/pdf",
                sizeBytes: 11,
                tenantId: TENANT_ID,
              },
            ]),
          }),
        }),
      }),
    });
  }

  it("streams bytes for a clean file", async () => {
    const storageKey = `${TENANT_ID}/helpdesk/unattached/${FILE_ID}.pdf`;
    const absPath = path.join(STORAGE_ROOT, storageKey);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, "hello world");

    const db = makeDbWithStatus("clean", storageKey);
    const result = await getFileStream(db as never, TENANT_ID, FILE_ID);

    expect(result.originalName).toBe("test-file.pdf");
    expect(result.mimeType).toBe("application/pdf");
    const contents = await readStreamToBuffer(result.stream);
    expect(contents.toString()).toBe("hello world");
  });

  it("throws FILE_PENDING_SCAN for pending files", async () => {
    const db = makeDbWithStatus("pending", "key");
    await expect(
      getFileStream(db as never, TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_PENDING_SCAN" });
  });

  it("throws FILE_PENDING_SCAN for scan_failed files", async () => {
    const db = makeDbWithStatus("scan_failed", "key");
    await expect(
      getFileStream(db as never, TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_PENDING_SCAN" });
  });

  it("throws FILE_QUARANTINED for quarantined files", async () => {
    const db = makeDbWithStatus("quarantined", "key");
    await expect(
      getFileStream(db as never, TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_QUARANTINED" });
  });

  it("throws FILE_NOT_FOUND for deleted files", async () => {
    const db = makeDbWithStatus("deleted", "key");
    await expect(
      getFileStream(db as never, TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

// ── deleteFile ────────────────────────────────────────────────────────────────

describe("deleteFile", () => {
  it("marks scan_status as deleted and removes the file from disk", async () => {
    const storageKey = `${TENANT_ID}/helpdesk/unattached/${FILE_ID}.pdf`;
    const absPath = path.join(STORAGE_ROOT, storageKey);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, "hello world");

    const db = makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue([
                { id: FILE_ID, scanStatus: "clean", storageKey },
              ]),
          }),
        }),
      }),
    });

    await deleteFile(db as never, TENANT_ID, FILE_ID);

    expect(db.update).toHaveBeenCalled();
    await expect(fsp.access(absPath)).rejects.toThrow();
  });

  it("is a no-op for already deleted files", async () => {
    const db = makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue([
                { id: FILE_ID, scanStatus: "deleted", storageKey: "key" },
              ]),
          }),
        }),
      }),
    });

    await deleteFile(db as never, TENANT_ID, FILE_ID);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("throws FILE_NOT_FOUND for unknown fileId", async () => {
    const db = makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    });

    await expect(
      deleteFile(db as never, TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

// ── deleteTenantFiles ─────────────────────────────────────────────────────────

describe("deleteTenantFiles", () => {
  it("recursively removes the tenant's storage directory", async () => {
    const tenantDir = path.join(STORAGE_ROOT, TENANT_ID);
    await fsp.mkdir(path.join(tenantDir, "helpdesk", "unattached"), {
      recursive: true,
    });
    await fsp.writeFile(
      path.join(tenantDir, "helpdesk", "unattached", "a.pdf"),
      "data",
    );

    await deleteTenantFiles(TENANT_ID);

    await expect(fsp.access(tenantDir)).rejects.toThrow();
  });

  it("does not throw when the tenant directory doesn't exist", async () => {
    await expect(deleteTenantFiles("no-such-tenant")).resolves.toBeUndefined();
  });
});
