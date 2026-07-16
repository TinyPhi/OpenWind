/**
 * index.test.ts — @platform/files unit tests
 * S3 SDK, BullMQ, and DB are fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Redis } from "ioredis";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPresignedPost = vi.fn();
const mockGetSignedUrl = vi.fn();
const mockS3Send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return { send: mockS3Send };
  }),
  DeleteObjectCommand: vi.fn(),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  createPresignedPost: (...args: unknown[]) => mockPresignedPost(...args),
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

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

vi.mock("@platform/config", () => ({
  env: {
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY: "test",
    S3_SECRET_KEY: "test",
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

const { initiateUpload, confirmUpload, getDownloadUrl, deleteFile } =
  await import("./index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const TENANT_ID = "tenant-aaa";
const USER_ID = "user-bbb";
const FILE_ID = "file-ccc";

function makeRedis(): Redis {
  return {} as Redis;
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
 * SELECT FOR UPDATE inside initiateUpload's transaction) and plain `.limit()`.
 */
function makeDb(overrides: Partial<MockDb> = {}): MockDb {
  // Build the base mock without `transaction` first so we can close over it.
  const mockDb: MockDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          // Support .for("update").limit() as well as plain .limit()
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
      // initiateUpload no longer calls .returning() — fileId is pre-generated
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    // Used inside transactions for `SELECT set_config('app.tenant_id', ...)`.
    execute: vi.fn().mockResolvedValue(undefined),
    // Placeholder — replaced below once mockDb is in scope
    transaction: vi.fn(),
    ...overrides,
  };

  // Wire transaction after construction: pass the same mock as `tx` so selects
  // inside the transaction use the same (possibly overridden) mock chains.
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
  mockS3Send.mockResolvedValue({});
  mockPresignedPost.mockResolvedValue({
    url: "https://s3.example.com/presigned",
  });
  mockGetSignedUrl.mockResolvedValue("https://s3.example.com/signed-url");
});

// ── initiateUpload ────────────────────────────────────────────────────────────

describe("initiateUpload", () => {
  it("returns fileId + presigned upload URL for a valid request", async () => {
    // The first select (FOR UPDATE on tenants) and second select (used bytes)
    // share a call counter so each resolves with the appropriate data.
    let selectCallCount = 0;
    const limitFn = vi.fn().mockImplementation(() => {
      selectCallCount++;
      if (selectCallCount === 1) {
        // SELECT FOR UPDATE on tenants → quota config
        return Promise.resolve([{ config: { storage_quota_mb: 100 } }]);
      }
      // getTenantUsedBytes → used = 0
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

    const result = await initiateUpload(
      db as never,
      TENANT_ID,
      USER_ID,
      "helpdesk",
      null,
      "report.pdf",
      "application/pdf",
      1024,
    );

    // fileId is now a pre-generated randomUUID() — just verify it's a UUID string
    expect(result.fileId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.uploadUrl).toBe("https://s3.example.com/signed-url");
    expect(result.uploadUrlExpiresAt).toBeInstanceOf(Date);
  });

  it("throws FILE_TOO_LARGE when sizeBytes exceeds 100MB", async () => {
    const db = makeDb();
    await expect(
      initiateUpload(
        db as never,
        TENANT_ID,
        USER_ID,
        "helpdesk",
        null,
        "huge.zip",
        "application/zip",
        101 * 1024 * 1024, // 101 MB
      ),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("throws FILE_TOO_LARGE for an image over its per-mime-type cap even though it's under the flat 100MB max", async () => {
    const db = makeDb();
    await expect(
      initiateUpload(
        db as never,
        TENANT_ID,
        USER_ID,
        "helpdesk",
        null,
        "huge.png",
        "image/png",
        20 * 1024 * 1024, // 20 MB — under the flat 100MB cap, over the 10MB image cap
      ),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("allows an image under its per-mime-type cap", async () => {
    const db = makeDb();
    const result = await initiateUpload(
      db as never,
      TENANT_ID,
      USER_ID,
      "helpdesk",
      null,
      "small.png",
      "image/png",
      5 * 1024 * 1024, // 5 MB — under the 10MB image cap
    );

    expect(result.fileId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("throws QUOTA_EXCEEDED when upload would exceed tenant quota", async () => {
    // First select: SELECT FOR UPDATE on tenants → quota = 1 MB
    // Second select: getTenantUsedBytes → used = 1 MB exactly
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
      initiateUpload(
        db as never,
        TENANT_ID,
        USER_ID,
        "helpdesk",
        null,
        "report.pdf",
        "application/pdf",
        1024, // 1 KB on a fully-used 1 MB quota → exceeds
      ),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  });
});

// ── confirmUpload ─────────────────────────────────────────────────────────────

describe("confirmUpload", () => {
  it("enqueues an av-scan job for a pending file", async () => {
    const db = makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: FILE_ID,
                tenantId: TENANT_ID,
                storageKey: "tenant/module/entity/file.pdf",
                scanStatus: "pending",
              },
            ]),
          }),
        }),
      }),
    });

    await confirmUpload(db as never, makeRedis(), TENANT_ID, FILE_ID);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "scan",
      expect.objectContaining({ fileId: FILE_ID, tenantId: TENANT_ID }),
      expect.objectContaining({ jobId: `av-scan-${FILE_ID}` }),
    );
  });

  it("is idempotent — does not re-enqueue if scan_status is already clean", async () => {
    const db = makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue([
                { id: FILE_ID, scanStatus: "clean", storageKey: "key" },
              ]),
          }),
        }),
      }),
    });

    await confirmUpload(db as never, makeRedis(), TENANT_ID, FILE_ID);
    expect(mockQueueAdd).not.toHaveBeenCalled();
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
      confirmUpload(db as never, makeRedis(), TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

// ── getDownloadUrl ────────────────────────────────────────────────────────────

describe("getDownloadUrl", () => {
  function makeDbWithStatus(scanStatus: string) {
    return makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                id: FILE_ID,
                scanStatus,
                storageKey: "key",
                originalName: "test-file.pdf",
                tenantId: TENANT_ID,
              },
            ]),
          }),
        }),
      }),
    });
  }

  it("returns a presigned download URL for a clean file", async () => {
    const db = makeDbWithStatus("clean");
    const result = await getDownloadUrl(db as never, TENANT_ID, FILE_ID);
    expect(result.downloadUrl).toBe("https://s3.example.com/signed-url");
    expect(result.downloadUrlExpiresAt).toBeInstanceOf(Date);
  });

  it("throws FILE_PENDING_SCAN for pending files", async () => {
    const db = makeDbWithStatus("pending");
    await expect(
      getDownloadUrl(db as never, TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_PENDING_SCAN" });
  });

  it("throws FILE_PENDING_SCAN for scan_failed files", async () => {
    const db = makeDbWithStatus("scan_failed");
    await expect(
      getDownloadUrl(db as never, TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_PENDING_SCAN" });
  });

  it("throws FILE_QUARANTINED for quarantined files", async () => {
    const db = makeDbWithStatus("quarantined");
    await expect(
      getDownloadUrl(db as never, TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_QUARANTINED" });
  });

  it("throws FILE_NOT_FOUND for deleted files", async () => {
    const db = makeDbWithStatus("deleted");
    await expect(
      getDownloadUrl(db as never, TENANT_ID, FILE_ID),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

// ── deleteFile ────────────────────────────────────────────────────────────────

describe("deleteFile", () => {
  it("marks scan_status as deleted", async () => {
    const db = makeDb({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue([
                { id: FILE_ID, scanStatus: "clean", storageKey: "key" },
              ]),
          }),
        }),
      }),
    });

    await deleteFile(db as never, TENANT_ID, FILE_ID);

    expect(db.update).toHaveBeenCalled();
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
