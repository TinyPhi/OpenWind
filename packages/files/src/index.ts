/**
 * @platform/files
 *
 * Tenant-scoped file storage on local disk, with async AV scanning.
 *
 * Upload flow:
 *  1. POST /files  → saveUpload  → writes bytes to disk, inserts row, enqueues AV scan
 *  2. Worker scans and transitions: pending → clean | quarantined | scan_failed
 *
 * Access:
 *  - GET /files/:id  → getFileStream  → readable stream (clean files only)
 *  - DELETE /files/:id  → deleteFile  → soft delete + disk removal
 *
 * Quota:
 *  - Enforced per-tenant at saveUpload via SELECT FOR UPDATE on tenants row
 *  - Soft-deleted files release quota immediately
 *  - Pending files abandoned >24h release quota when purged by the cleanup job
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { eq, and, sql, ne } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { files, tenants } from "@platform/db";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { FileError } from "./errors.js";

export { FileError } from "./errors.js";
export type { FileErrorCode } from "./errors.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_QUOTA_MB = 5120; // 5 GB
const AV_SCAN_QUEUE = "av-scan";

// Mirrors apps/admin-ui/src/hooks/use-file-upload.ts's getSizeLimit — the
// client enforces these per-mime-type caps for UX, but the server is the only
// place they're actually load-bearing; without this, any caller bypassing the
// client (or a modified client) could upload up to MAX_FILE_BYTES regardless
// of mime type.
function getMimeSizeLimit(mimeType: string): number {
  if (mimeType.startsWith("image/")) return 10 * 1024 * 1024;
  if (mimeType.startsWith("text/") || mimeType === "application/json")
    return 5 * 1024 * 1024;
  if (
    mimeType === "application/zip" ||
    mimeType === "application/x-zip-compressed"
  )
    return MAX_FILE_BYTES;
  return 50 * 1024 * 1024;
}

// ── Storage key / path helpers ────────────────────────────────────────────────

function buildStorageKey(
  tenantId: string,
  moduleSlug: string,
  entityId: string | null,
  fileId: string,
  filename: string,
): string {
  const entitySegment = entityId ?? "unattached";
  // Sanitise filename — keep extension only, replace everything else
  const ext = filename.includes(".") ? (filename.split(".").pop() ?? "") : "";
  const safeName = ext ? `${fileId}.${ext}` : fileId;
  return `${tenantId}/${moduleSlug}/${entitySegment}/${safeName}`;
}

/** Resolves a storage key (relative, DB-stored) to an absolute on-disk path. */
export function resolveStoragePath(storageKey: string): string {
  return path.join(env.FILES_STORAGE_PATH, storageKey);
}

/**
 * Write bytes to `absPath` durably: write to a sibling temp file, then
 * rename into place. A reader can never observe a partially-written file at
 * `absPath` — either the old file (or nothing) is there, or the complete
 * new one is.
 */
async function writeFileAtomic(absPath: string, data: Buffer): Promise<void> {
  const tmpPath = `${absPath}.tmp-${randomUUID()}`;
  try {
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(tmpPath, data);
    await fsp.rename(tmpPath, absPath);
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => undefined);
    throw new FileError("STORAGE_WRITE_FAILED", { err: String(err) });
  }
}

// ── Quota helpers ─────────────────────────────────────────────────────────────

async function getTenantUsedBytes(
  db: DbOrTx,
  tenantId: string,
): Promise<number> {
  // Aggregate returns exactly one row — limit(1) makes the mock chain consistent
  // with getTenantQuotaBytes and satisfies the Drizzle query builder type.
  const [result] = await db
    .select({ total: sql<string>`COALESCE(SUM(size_bytes), 0)` })
    .from(files)
    .where(and(eq(files.tenantId, tenantId), ne(files.scanStatus, "deleted")))
    .limit(1);
  return parseInt(result?.total ?? "0", 10);
}

// ── Public API ────────────────────────────────────────────────────────────────

export type SaveUploadResult = {
  fileId: string;
  scanStatus: string;
};

/**
 * Validate size/quota, write the file to disk, insert its row, and enqueue
 * the AV scan job — all within one call, since the upload route now
 * receives the full multipart body in a single request.
 *
 * The fileId is generated before the write so the final storageKey/path is
 * known up front. Quota enforcement is atomic: `SELECT ... FOR UPDATE` on
 * the tenant row serialises concurrent saveUpload calls so two simultaneous
 * uploads cannot both pass the same quota check.
 */
export async function saveUpload(
  db: DbOrTx,
  redis: Redis,
  tenantId: string,
  uploadedBy: string,
  moduleSlug: string,
  entityId: string | null,
  filename: string,
  mimeType: string,
  bytes: Buffer,
): Promise<SaveUploadResult> {
  const sizeBytes = bytes.byteLength;

  // 1. Enforce per-file size limit — both the flat ceiling and the
  // per-mime-type cap the client also enforces client-side.
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new FileError("FILE_TOO_LARGE", {
      sizeBytes,
      maxBytes: MAX_FILE_BYTES,
    });
  }
  const mimeLimit = getMimeSizeLimit(mimeType);
  if (sizeBytes > mimeLimit) {
    throw new FileError("FILE_TOO_LARGE", {
      sizeBytes,
      maxBytes: mimeLimit,
    });
  }

  // 2. Pre-generate fileId so the final storageKey is known before writing.
  const fileId = randomUUID();
  const storageKey = buildStorageKey(
    tenantId,
    moduleSlug,
    entityId,
    fileId,
    filename,
  );

  // 3. Atomically check quota and insert the file row.
  //    SELECT FOR UPDATE on the tenant row serialises concurrent uploads —
  //    two simultaneous calls cannot both read the same usedBytes and both pass.
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    // Lock the tenant row for the duration of this transaction
    const [tenant] = await tx
      .select({ config: tenants.config })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for("update")
      .limit(1);

    const config =
      (tenant?.config as Record<string, unknown> | undefined) ?? {};
    const quotaMb =
      typeof config["storage_quota_mb"] === "number"
        ? config["storage_quota_mb"]
        : DEFAULT_QUOTA_MB;
    const quotaBytes = quotaMb * 1024 * 1024;

    const usedBytes = await getTenantUsedBytes(tx, tenantId);

    if (usedBytes + sizeBytes > quotaBytes) {
      throw new FileError("QUOTA_EXCEEDED", {
        usedBytes,
        requestedBytes: sizeBytes,
        quotaBytes,
      });
    }

    await tx.insert(files).values({
      id: fileId,
      tenantId,
      moduleSlug,
      entityId: entityId ?? undefined,
      originalName: filename,
      storageKey,
      mimeType,
      sizeBytes,
      scanStatus: "pending",
      uploadedBy,
    });
  });

  // 4. Write bytes to disk only after the row is committed — if the write
  // fails, the row still exists as "pending" and never transitions past it
  // (no download is ever served for a non-"clean" file).
  await writeFileAtomic(resolveStoragePath(storageKey), bytes);

  // 5. Enqueue the AV scan job (dev shortcut: SKIP_AV_SCAN marks clean immediately).
  if (env.SKIP_AV_SCAN) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
      );
      await tx
        .update(files)
        .set({ scanStatus: "clean", updatedAt: new Date() })
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));
    });
    logger.info(
      { tenantId, fileId },
      "files: SKIP_AV_SCAN=true — marked clean without scanning",
    );
    return { fileId, scanStatus: "clean" };
  }

  const queue = new Queue<{
    fileId: string;
    tenantId: string;
    storageKey: string;
  }>(AV_SCAN_QUEUE, { connection: redis });

  try {
    await queue.add(
      "scan",
      { fileId, tenantId, storageKey },
      {
        jobId: `av-scan-${fileId}`, // deduplication key — prevents double-enqueue; no colon (BullMQ disallows it)
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { age: 3600 },
        removeOnFail: { age: 604800 },
      },
    );
  } finally {
    await queue.close();
  }

  logger.info(
    { tenantId, fileId, moduleSlug, sizeBytes },
    "files: upload saved, av scan enqueued",
  );

  return { fileId, scanStatus: "pending" };
}

export type FileStreamResult = {
  stream: fs.ReadStream;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

/**
 * Open a readable stream for a clean file.
 * Throws for pending, quarantined, scan_failed, or deleted files.
 */
export async function getFileStream(
  db: DbOrTx,
  tenantId: string,
  fileId: string,
): Promise<FileStreamResult> {
  const [file] = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    return tx
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
      .limit(1);
  });

  if (!file) throw new FileError("FILE_NOT_FOUND", { fileId });

  switch (file.scanStatus) {
    case "pending":
    case "scan_failed":
      throw new FileError("FILE_PENDING_SCAN", {
        fileId,
        scanStatus: file.scanStatus,
      });
    case "quarantined":
      throw new FileError("FILE_QUARANTINED", { fileId });
    case "deleted":
      throw new FileError("FILE_NOT_FOUND", { fileId });
  }

  // scanStatus === "clean"
  const absPath = resolveStoragePath(file.storageKey);
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(absPath);
  } catch (err) {
    throw new FileError("STORAGE_READ_FAILED", {
      fileId,
      err: String(err),
    });
  }

  return {
    stream,
    originalName: file.originalName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  };
}

/**
 * Soft-delete a file: sets scan_status to 'deleted' and removes the bytes
 * from disk. Quota is released immediately.
 */
export async function deleteFile(
  db: DbOrTx,
  tenantId: string,
  fileId: string,
): Promise<void> {
  let storageKeyToDelete: string | undefined;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );

    const [file] = await tx
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
      .limit(1);

    if (!file) throw new FileError("FILE_NOT_FOUND", { fileId });
    if (file.scanStatus === "deleted") return; // already deleted — no-op

    await tx
      .update(files)
      .set({ scanStatus: "deleted", updatedAt: new Date() })
      .where(eq(files.id, fileId));

    storageKeyToDelete = file.storageKey;
  });

  if (!storageKeyToDelete) return;

  await fsp
    .unlink(resolveStoragePath(storageKeyToDelete))
    .catch((err: unknown) => {
      logger.warn(
        { tenantId, fileId, storageKey: storageKeyToDelete, err: String(err) },
        "files: on-disk file deletion failed",
      );
    });

  logger.info({ tenantId, fileId }, "files: file soft-deleted");
}

/**
 * Recursively remove a tenant's entire storage directory.
 * Used by the tenant-purge worker for GDPR hard-deletion.
 */
export async function deleteTenantFiles(tenantId: string): Promise<void> {
  const tenantDir = resolveStoragePath(tenantId);
  await fsp
    .rm(tenantDir, { recursive: true, force: true })
    .catch((err: unknown) => {
      logger.warn(
        { tenantId, err: String(err) },
        "files: tenant directory deletion failed — storage may leak",
      );
    });
  logger.info({ tenantId }, "files: tenant files deleted");
}
