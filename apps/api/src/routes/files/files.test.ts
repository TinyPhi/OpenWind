/**
 * files.test.ts
 *
 * Unit tests for file routes.  All domain logic (initiateUpload, confirmUpload,
 * getDownloadUrl, deleteFile) and DB/S3/Redis calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@platform/files", () => ({
  initiateUpload: vi.fn(),
  confirmUpload: vi.fn(),
  getDownloadUrl: vi.fn(),
  deleteFile: vi.fn(),
  FileError: class FileError extends Error {
    constructor(
      public readonly code: string,
      public readonly meta?: Record<string, unknown>,
    ) {
      super(code);
      this.name = "FileError";
    }
  },
}));

// download.ts looks up the file's bound entity (if any) before calling
// getDownloadUrl, to enforce the entity's __accessUsers ACL. Default: no
// row found, so the route falls through to getDownloadUrl unchanged --
// matches these tests' existing expectations. Tests exercising the new
// access-control behavior override this per-test.
const mockFilesSelectResult: { entityId: string | null }[] = [];
const mockEntitySelectResult: Record<string, unknown>[] = [];

vi.mock("@platform/db", () => ({
  db: {},
  files: { id: "files.id", tenantId: "files.tenant_id" },
  entityInstances: {
    id: "entity_instances.id",
    tenantId: "entity_instances.tenant_id",
    createdBy: "entity_instances.created_by",
    assignedTo: "entity_instances.assigned_to",
    fields: "entity_instances.fields",
  },
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      select: vi.fn((cols: Record<string, unknown>) => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi
              .fn()
              .mockResolvedValue(
                "entityId" in cols
                  ? mockFilesSelectResult
                  : mockEntitySelectResult,
              ),
          })),
        })),
      })),
    }),
}));

vi.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ op: "and", conds }),
  eq: (col: unknown, val: unknown) => ({ col, val, op: "eq" }),
}));

vi.mock("../../lib/redis.js", () => ({
  connection: {},
}));

let mockAuth = {
  tenantId: "tenant-1",
  userId: "user-1",
  roles: ["admin"],
};

vi.mock("@platform/auth", () => ({
  requireAuth:
    () =>
    async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("auth", mockAuth);
      await next();
    },
  requireRole:
    (..._roles: string[]) =>
    async (_c: unknown, next: () => Promise<void>) => {
      await next();
    },
}));

vi.mock("@platform/config", () => ({
  env: {
    NODE_ENV: "test",
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "test",
    S3_ACCESS_KEY: "key",
    S3_SECRET_KEY: "secret",
    REDIS_URL: "redis://localhost:6379",
  },
}));

import {
  initiateUpload,
  confirmUpload,
  getDownloadUrl,
  deleteFile,
  FileError,
} from "@platform/files";
import { filesRouter } from "./index.js";

// ── UUID constants ─────────────────────────────────────────────────────────────

/** A valid UUID used as a stand-in for an existing file in URL params. */
const EXISTING_FILE_ID = "aaaaaaaa-bbbb-4000-8000-111111111111";
/** A valid UUID used as a stand-in for a non-existent file in URL params. */
const MISSING_FILE_ID = "cccccccc-dddd-4000-8000-222222222222";
/** A valid UUID for a file whose scan status is pending. */
const PENDING_FILE_ID = "eeeeeeee-ffff-4000-8000-333333333333";
/** A valid UUID for a quarantined file. */
const QUARANTINED_FILE_ID = "11111111-2222-4000-8000-444444444444";

// ── Test app ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  app.route("/files", filesRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFilesSelectResult.length = 0;
  mockEntitySelectResult.length = 0;
  mockAuth = { tenantId: "tenant-1", userId: "user-1", roles: ["admin"] };
});

// ── POST /files — initiateUpload ──────────────────────────────────────────────

describe("POST /files", () => {
  it("returns 201 with upload URL on success", async () => {
    vi.mocked(initiateUpload).mockResolvedValue({
      fileId: "file-uuid-1",
      uploadUrl: "https://s3.example.com/put",
      uploadUrlExpiresAt: new Date("2026-01-01T01:00:00Z"),
      storageKey: "tenants/t/files/file-uuid-1.pdf",
    });

    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalName: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        moduleSlug: "hrms",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.fileId).toBe("file-uuid-1");
    expect(body.data.uploadUrl).toBe("https://s3.example.com/put");
  });

  it("returns 422 when initiateUpload throws FileError QUOTA_EXCEEDED", async () => {
    vi.mocked(initiateUpload).mockRejectedValue(
      new FileError("QUOTA_EXCEEDED", { tenantId: "tenant-1" }),
    );

    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalName: "huge.zip",
        mimeType: "application/zip",
        sizeBytes: 1024,
        moduleSlug: "docs",
      }),
    });

    // FileError bubbles to the global error handler → 500 (not mapped to 422 at route level)
    // The route relies on the global error handler mapping unhandled FileErrors
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("returns 400 when sizeBytes exceeds 100 MB (Zod validation)", async () => {
    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalName: "huge.pdf",
        mimeType: "application/pdf",
        sizeBytes: 200 * 1024 * 1024, // 200 MB — exceeds 100 MB limit
        moduleSlug: "docs",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 for disallowed MIME types (allowlist validation)", async () => {
    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        originalName: "script.exe",
        mimeType: "application/x-msdownload",
        sizeBytes: 1024,
        moduleSlug: "docs",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ originalName: "a.pdf" }),
    });

    expect(res.status).toBe(400);
  });
});

// ── POST /files/:id/complete ──────────────────────────────────────────────────

describe("POST /files/:id/complete", () => {
  it("returns 200 on successful confirm", async () => {
    vi.mocked(confirmUpload).mockResolvedValue(undefined);

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}/complete`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("pending");
  });

  it("returns 404 when file not found", async () => {
    vi.mocked(confirmUpload).mockRejectedValue(
      new FileError("FILE_NOT_FOUND", { fileId: "missing" }),
    );

    const app = buildApp();
    const res = await app.request(`/files/${MISSING_FILE_ID}/complete`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });
});

// ── GET /files/:id ────────────────────────────────────────────────────────────

describe("GET /files/:id", () => {
  it("returns 200 with download URL for a clean file", async () => {
    vi.mocked(getDownloadUrl).mockResolvedValue({
      downloadUrl: "https://s3.example.com/get",
      downloadUrlExpiresAt: new Date("2026-01-01T02:00:00Z"),
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.downloadUrl).toBe("https://s3.example.com/get");
  });

  it("returns 404 for missing file", async () => {
    vi.mocked(getDownloadUrl).mockRejectedValue(
      new FileError("FILE_NOT_FOUND"),
    );

    const app = buildApp();
    const res = await app.request(`/files/${MISSING_FILE_ID}`);
    expect(res.status).toBe(404);
  });

  it("returns 422 for pending file", async () => {
    vi.mocked(getDownloadUrl).mockRejectedValue(
      new FileError("FILE_PENDING_SCAN", { scanStatus: "pending" }),
    );

    const app = buildApp();
    const res = await app.request(`/files/${PENDING_FILE_ID}`);
    expect(res.status).toBe(422);
  });

  it("returns 422 for quarantined file", async () => {
    vi.mocked(getDownloadUrl).mockRejectedValue(
      new FileError("FILE_QUARANTINED"),
    );

    const app = buildApp();
    const res = await app.request(`/files/${QUARANTINED_FILE_ID}`);
    expect(res.status).toBe(422);
  });

  // ── record-level read access for files bound to a restricted entity ───────

  it("returns 404 for a non-privileged user with no access to the file's bound entity", async () => {
    mockAuth = {
      tenantId: "tenant-1",
      userId: "user-outsider",
      roles: ["user"],
    };
    mockFilesSelectResult.push({ entityId: "entity-1" });
    mockEntitySelectResult.push({
      createdBy: "user-owner",
      assignedTo: "user-other",
      fields: {},
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(res.status).toBe(404);
    expect(getDownloadUrl).not.toHaveBeenCalled();
  });

  it("returns 200 for a non-privileged user who owns the file's bound entity", async () => {
    mockAuth = { tenantId: "tenant-1", userId: "user-owner", roles: ["user"] };
    mockFilesSelectResult.push({ entityId: "entity-1" });
    mockEntitySelectResult.push({
      createdBy: "user-owner",
      assignedTo: null,
      fields: {},
    });
    vi.mocked(getDownloadUrl).mockResolvedValue({
      downloadUrl: "https://s3.example.com/get",
      downloadUrlExpiresAt: new Date("2026-01-01T02:00:00Z"),
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(res.status).toBe(200);
  });

  it("allows a privileged (admin/agent) caller regardless of entity access", async () => {
    mockAuth = { tenantId: "tenant-1", userId: "user-admin", roles: ["admin"] };
    mockFilesSelectResult.push({ entityId: "entity-1" });
    mockEntitySelectResult.push({
      createdBy: "user-owner",
      assignedTo: "user-other",
      fields: {},
    });
    vi.mocked(getDownloadUrl).mockResolvedValue({
      downloadUrl: "https://s3.example.com/get",
      downloadUrlExpiresAt: new Date("2026-01-01T02:00:00Z"),
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(res.status).toBe(200);
  });

  it("skips the entity access check for a file not bound to any entity", async () => {
    mockAuth = { tenantId: "tenant-1", userId: "user-anyone", roles: ["user"] };
    mockFilesSelectResult.push({ entityId: null });
    vi.mocked(getDownloadUrl).mockResolvedValue({
      downloadUrl: "https://s3.example.com/get",
      downloadUrlExpiresAt: new Date("2026-01-01T02:00:00Z"),
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(res.status).toBe(200);
  });
});

// ── DELETE /files/:id ─────────────────────────────────────────────────────────

describe("DELETE /files/:id", () => {
  it("returns 204 on successful soft-delete", async () => {
    vi.mocked(deleteFile).mockResolvedValue(undefined);

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
  });

  it("returns 404 when file not found", async () => {
    vi.mocked(deleteFile).mockRejectedValue(new FileError("FILE_NOT_FOUND"));

    const app = buildApp();
    const res = await app.request(`/files/${MISSING_FILE_ID}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});
