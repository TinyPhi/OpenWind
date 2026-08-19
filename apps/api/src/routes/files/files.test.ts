/**
 * files.test.ts
 *
 * Unit tests for file routes.  All domain logic (saveUpload, getFileStream,
 * deleteFile) and DB/disk/Redis calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { Readable } from "node:stream";
import type fs from "node:fs";

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@platform/files", () => ({
  saveUpload: vi.fn(),
  getFileStream: vi.fn(),
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
// getFileStream, to enforce the entity's __accessUsers ACL. Default: no
// row found, so the route falls through to getFileStream unchanged --
// matches these tests' existing expectations. Tests exercising the new
// access-control behavior override this per-test.
const mockFilesSelectResult: {
  entityId: string | null;
  uploadedBy?: string;
  originalName?: string;
}[] = [];
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

const mockEmitFileDownloaded = vi.fn();
const mockEmitFileDeleted = vi.fn();
vi.mock("../../lib/emit-access-event.js", () => ({
  emitFileDownloaded: (...args: unknown[]) => mockEmitFileDownloaded(...args),
  emitFileDeleted: (...args: unknown[]) => mockEmitFileDeleted(...args),
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
    FILES_STORAGE_PATH: "/data/files",
    REDIS_URL: "redis://localhost:6379",
  },
}));

import {
  saveUpload,
  getFileStream,
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

function makeUploadForm(
  overrides: {
    fileName?: string;
    mimeType?: string;
    content?: string;
    moduleSlug?: string;
    entityId?: string;
  } = {},
) {
  const form = new FormData();
  const file = new File(
    [overrides.content ?? "file contents"],
    overrides.fileName ?? "report.pdf",
    { type: overrides.mimeType ?? "application/pdf" },
  );
  form.set("file", file);
  form.set("moduleSlug", overrides.moduleSlug ?? "hrms");
  if (overrides.entityId) form.set("entityId", overrides.entityId);
  return form;
}

function makeStream(content = "file contents"): fs.ReadStream {
  return Readable.from([Buffer.from(content)]) as unknown as fs.ReadStream;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFilesSelectResult.length = 0;
  mockEntitySelectResult.length = 0;
  mockAuth = { tenantId: "tenant-1", userId: "user-1", roles: ["admin"] };
  mockEmitFileDownloaded.mockReset();
  mockEmitFileDeleted.mockReset();
});

// ── POST /files — saveUpload ──────────────────────────────────────────────────

describe("POST /files", () => {
  it("returns 201 with fileId on success", async () => {
    vi.mocked(saveUpload).mockResolvedValue({
      fileId: "file-uuid-1",
      scanStatus: "pending",
    });

    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      body: makeUploadForm(),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.fileId).toBe("file-uuid-1");
    expect(body.data.scanStatus).toBe("pending");
  });

  it("returns 422 when saveUpload throws FileError QUOTA_EXCEEDED", async () => {
    vi.mocked(saveUpload).mockRejectedValue(
      new FileError("QUOTA_EXCEEDED", { tenantId: "tenant-1" }),
    );

    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      body: makeUploadForm({
        fileName: "huge.zip",
        mimeType: "application/zip",
      }),
    });

    expect(res.status).toBe(422);
  });

  it("returns 422 for a moduleSlug containing path traversal segments", async () => {
    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      body: makeUploadForm({ moduleSlug: "../../../../../../tmp/pwned" }),
    });

    expect(res.status).toBe(422);
    expect(saveUpload).not.toHaveBeenCalled();
  });

  it("returns 422 for a moduleSlug containing a path separator", async () => {
    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      body: makeUploadForm({ moduleSlug: "hrms/../../etc" }),
    });

    expect(res.status).toBe(422);
    expect(saveUpload).not.toHaveBeenCalled();
  });

  it("returns 422 when file exceeds 100 MB (route-level size check)", async () => {
    // Constructing a real 100MB+ File in a test is wasteful; instead confirm
    // saveUpload's FILE_TOO_LARGE error maps to 422 (the size check itself is
    // covered by @platform/files' own unit tests).
    vi.mocked(saveUpload).mockRejectedValue(
      new FileError("FILE_TOO_LARGE", { sizeBytes: 1 }),
    );

    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      body: makeUploadForm(),
    });

    expect(res.status).toBe(422);
  });

  it("returns 422 for disallowed MIME types (allowlist validation)", async () => {
    const app = buildApp();
    const res = await app.request("/files", {
      method: "POST",
      body: makeUploadForm({
        fileName: "script.exe",
        mimeType: "application/x-msdownload",
      }),
    });

    expect(res.status).toBe(422);
    expect(saveUpload).not.toHaveBeenCalled();
  });

  it("returns 400 when the file field is missing", async () => {
    const form = new FormData();
    form.set("moduleSlug", "hrms");

    const app = buildApp();
    const res = await app.request("/files", { method: "POST", body: form });

    expect(res.status).toBe(400);
  });

  it("returns 422 when moduleSlug is missing", async () => {
    const form = new FormData();
    form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));

    const app = buildApp();
    const res = await app.request("/files", { method: "POST", body: form });

    expect(res.status).toBe(422);
  });
});

// ── GET /files/:id ────────────────────────────────────────────────────────────

describe("GET /files/:id", () => {
  it("streams bytes with the correct headers for a clean file", async () => {
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream("hello world"),
      originalName: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 11,
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("report.pdf");
    const text = await res.text();
    expect(text).toBe("hello world");
  });

  it("returns 404 for missing file", async () => {
    vi.mocked(getFileStream).mockRejectedValue(new FileError("FILE_NOT_FOUND"));

    const app = buildApp();
    const res = await app.request(`/files/${MISSING_FILE_ID}`);
    expect(res.status).toBe(404);
  });

  it("forces Content-Disposition attachment for SVG regardless of inline flag (#240)", async () => {
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream("<svg/>"),
      originalName: "image.svg",
      mimeType: "image/svg+xml",
      sizeBytes: 6,
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}?inline=1`);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  });

  it("allows non-SVG files to be served inline when requested", async () => {
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream("hello world"),
      originalName: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 11,
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}?inline=1`);
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
  });

  it("strips CRLF from originalName to prevent header injection (#241)", async () => {
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream("hello world"),
      originalName: "evil\r\nX-Injected: hdr.pdf",
      mimeType: "application/pdf",
      sizeBytes: 11,
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
  });

  it("strips double-quotes from originalName to prevent value termination (#241)", async () => {
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream("hello world"),
      originalName: 'file"name.pdf',
      mimeType: "application/pdf",
      sizeBytes: 11,
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);
    const disposition = res.headers.get("content-disposition") ?? "";
    const filenameMatch = /filename="([^"]*)"/.exec(disposition);
    expect(filenameMatch).not.toBeNull();
    expect(filenameMatch![1]).not.toContain('"');
  });

  it("includes RFC 5987 filename* for Unicode filenames (#241)", async () => {
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream("hello world"),
      originalName: "résumé.pdf",
      mimeType: "application/pdf",
      sizeBytes: 11,
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("filename*=UTF-8''");
  });

  it("returns 422 for pending file", async () => {
    vi.mocked(getFileStream).mockRejectedValue(
      new FileError("FILE_PENDING_SCAN", { scanStatus: "pending" }),
    );

    const app = buildApp();
    const res = await app.request(`/files/${PENDING_FILE_ID}`);
    expect(res.status).toBe(422);
  });

  it("returns 422 for quarantined file", async () => {
    vi.mocked(getFileStream).mockRejectedValue(
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
    mockFilesSelectResult.push({
      entityId: "entity-1",
      uploadedBy: "user-owner",
    });
    mockEntitySelectResult.push({
      createdBy: "user-owner",
      assignedTo: "user-other",
      fields: {},
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(res.status).toBe(404);
    expect(getFileStream).not.toHaveBeenCalled();
  });

  it("returns 200 for a non-privileged user who owns the file's bound entity", async () => {
    mockAuth = { tenantId: "tenant-1", userId: "user-owner", roles: ["user"] };
    mockFilesSelectResult.push({
      entityId: "entity-1",
      uploadedBy: "user-owner",
    });
    mockEntitySelectResult.push({
      createdBy: "user-owner",
      assignedTo: null,
      fields: {},
    });
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream(),
      originalName: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 13,
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(res.status).toBe(200);
  });

  it("allows a privileged (admin/agent) caller regardless of entity access", async () => {
    mockAuth = { tenantId: "tenant-1", userId: "user-admin", roles: ["admin"] };
    mockFilesSelectResult.push({
      entityId: "entity-1",
      uploadedBy: "user-owner",
    });
    mockEntitySelectResult.push({
      createdBy: "user-owner",
      assignedTo: "user-other",
      fields: {},
    });
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream(),
      originalName: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 13,
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(res.status).toBe(200);
  });

  it("logs a file_downloaded history event when the file is bound to an entity (§3.4)", async () => {
    mockAuth = { tenantId: "tenant-1", userId: "user-admin", roles: ["admin"] };
    mockFilesSelectResult.push({
      entityId: "entity-1",
      uploadedBy: "user-owner",
    });
    mockEntitySelectResult.push({
      createdBy: "user-owner",
      assignedTo: null,
      fields: {},
    });
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream(),
      originalName: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 13,
    });

    const app = buildApp();
    await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(mockEmitFileDownloaded).toHaveBeenCalledWith(
      "tenant-1",
      "entity-1",
      "user-admin",
      EXISTING_FILE_ID,
      "report.pdf",
    );
  });

  it("does not log a history event for an unbound file (no entityId)", async () => {
    mockAuth = { tenantId: "tenant-1", userId: "user-owner", roles: ["user"] };
    mockFilesSelectResult.push({ entityId: null, uploadedBy: "user-owner" });
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream(),
      originalName: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 13,
    });

    const app = buildApp();
    await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(mockEmitFileDownloaded).not.toHaveBeenCalled();
  });

  it("allows the uploader to download their own unbound file (#224)", async () => {
    mockAuth = { tenantId: "tenant-1", userId: "user-owner", roles: ["user"] };
    mockFilesSelectResult.push({ entityId: null, uploadedBy: "user-owner" });
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream(),
      originalName: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 13,
    });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(res.status).toBe(200);
  });

  it("returns 404 for a non-uploader accessing an unbound file (#224)", async () => {
    mockAuth = {
      tenantId: "tenant-1",
      userId: "user-outsider",
      roles: ["user"],
    };
    mockFilesSelectResult.push({ entityId: null, uploadedBy: "user-owner" });

    const app = buildApp();
    const res = await app.request(`/files/${EXISTING_FILE_ID}`);

    expect(res.status).toBe(404);
    expect(getFileStream).not.toHaveBeenCalled();
  });

  it("allows admin to download any unbound file (#224)", async () => {
    mockAuth = { tenantId: "tenant-1", userId: "user-admin", roles: ["admin"] };
    mockFilesSelectResult.push({ entityId: null, uploadedBy: "user-owner" });
    vi.mocked(getFileStream).mockResolvedValue({
      stream: makeStream(),
      originalName: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 13,
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

  it("logs a file_deleted history event when the file is bound to an entity (§3.5)", async () => {
    mockFilesSelectResult.push({
      entityId: "entity-1",
      originalName: "report.pdf",
    });
    vi.mocked(deleteFile).mockResolvedValue(undefined);

    const app = buildApp();
    await app.request(`/files/${EXISTING_FILE_ID}`, { method: "DELETE" });

    expect(mockEmitFileDeleted).toHaveBeenCalledWith(
      "tenant-1",
      "entity-1",
      "user-1",
      EXISTING_FILE_ID,
      "report.pdf",
    );
  });

  it("does not log a history event for an unbound file (no entityId)", async () => {
    mockFilesSelectResult.push({ entityId: null, originalName: "report.pdf" });
    vi.mocked(deleteFile).mockResolvedValue(undefined);

    const app = buildApp();
    await app.request(`/files/${EXISTING_FILE_ID}`, { method: "DELETE" });

    expect(mockEmitFileDeleted).not.toHaveBeenCalled();
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
