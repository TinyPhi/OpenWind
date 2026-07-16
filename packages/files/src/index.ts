/**
 * @platform/files
 *
 * Tenant-scoped file storage with presigned S3 URLs and async AV scanning.
 *
 * Upload flow:
 *  1. POST /files  → initiateUpload  → presigned POST URL + fileId
 *  2. Client uploads directly to S3 (S3 enforces size limit via content-length-range)
 *  3. POST /files/:id/complete  → confirmUpload  → enqueues AV scan BullMQ job
 *  4. Worker scans and transitions: pending → clean | quarantined | scan_failed
 *
 * Access:
 *  - GET /files/:id  → getDownloadUrl  → presigned GET URL (clean files only)
 *  - DELETE /files/:id  → deleteFile  → soft delete + async S3 removal
 *
 * Quota:
 *  - Enforced per-tenant at initiateUpload via SELECT FOR UPDATE on tenants row
 *  - Soft-deleted files release quota immediately
 *  - Pending files abandoned >24h release quota when purged by the cleanup job
 */

import { randomUUID } from "node:crypto";
import {
  S3Client,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
const UPLOAD_URL_EXPIRY_SECONDS = 900; // 15 min
const DOWNLOAD_URL_EXPIRY_SECONDS = 3600; // 1 h
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

// ── S3 clients ────────────────────────────────────────────────────────────────
// Two clients are needed when S3_ENDPOINT is an internal Docker hostname:
//   getS3()          — internal endpoint, used for PUT/DELETE/GetObject commands
//   getS3ForSigning() — public endpoint (S3_PUBLIC_URL ?? S3_ENDPOINT), used only
//                       for presigning so the signature embeds the browser-accessible
//                       host. Rewriting the host after signing would break the HMAC.

let _s3: S3Client | undefined;
let _s3Signing: S3Client | undefined;

function getS3(): S3Client {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  if (_s3 === undefined) {
    _s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: "us-east-1",
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
      forcePathStyle: true,
    });
  }
  return _s3;
}

function getS3ForSigning(): S3Client {
  const publicEndpoint = env.S3_PUBLIC_URL ?? env.S3_ENDPOINT;

  if (_s3Signing === undefined || publicEndpoint !== env.S3_ENDPOINT) {
    _s3Signing = new S3Client({
      endpoint: publicEndpoint,
      region: "us-east-1",
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
      forcePathStyle: true,
    });
  }
  return _s3Signing;
}

// ── Storage key helpers ───────────────────────────────────────────────────────

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

export type InitiateUploadResult = {
  fileId: string;
  uploadUrl: string;
  uploadUrlExpiresAt: Date;
};

/**
 * Reserve a file slot, check quota, and issue a presigned S3 PUT URL.
 *
 * The fileId is generated client-side with `randomUUID()` before the INSERT,
 * eliminating the two-step "insert with placeholder key then update" pattern.
 *
 * Quota enforcement is atomic: `SELECT ... FOR UPDATE` on the tenant row
 * serialises concurrent initiateUpload calls so two simultaneous uploads
 * cannot both pass the same quota check.
 */
export async function initiateUpload(
  db: DbOrTx,
  tenantId: string,
  uploadedBy: string,
  moduleSlug: string,
  entityId: string | null,
  filename: string,
  mimeType: string,
  sizeBytes: number,
): Promise<InitiateUploadResult> {
  // 1. Enforce per-file size limit (no DB round-trip needed) — both the flat
  // ceiling and the per-mime-type cap the client also enforces client-side.
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

  // 2. Pre-generate fileId so the final storageKey is known before the INSERT.
  //    This avoids the old two-step INSERT (with placeholder key) + UPDATE pattern.
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

  // 4. Issue presigned PUT URL with exact content-length enforcement.
  //    S3 presigned PUT requires the client to send exactly Content-Length = sizeBytes.
  const expiresAt = new Date(Date.now() + UPLOAD_URL_EXPIRY_SECONDS * 1000);

  const uploadUrl = await getSignedUrl(
    getS3ForSigning(),
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: storageKey,
      ContentType: mimeType,
      ContentLength: sizeBytes,
    }),
    { expiresIn: UPLOAD_URL_EXPIRY_SECONDS },
  );

  logger.info(
    { tenantId, fileId, moduleSlug, sizeBytes },
    "files: upload initiated",
  );

  return { fileId, uploadUrl, uploadUrlExpiresAt: expiresAt };
}

/**
 * Signal that the S3 upload is complete and enqueue the AV scan job.
 * Idempotent — calling twice for the same fileId does not enqueue a second job.
 */
export async function confirmUpload(
  db: DbOrTx,
  redis: Redis,
  tenantId: string,
  fileId: string,
): Promise<void> {
  let storageKeyForScan: string | undefined;

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

    // Idempotency: only enqueue if still pending
    if (file.scanStatus !== "pending") {
      logger.info(
        { tenantId, fileId, scanStatus: file.scanStatus },
        "files: confirmUpload called on non-pending file — skipping enqueue",
      );
      return;
    }

    // Dev shortcut: skip the queue and mark clean immediately when SKIP_AV_SCAN=true
    if (env.SKIP_AV_SCAN) {
      await tx
        .update(files)
        .set({ scanStatus: "clean", updatedAt: new Date() })
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));
      logger.info(
        { tenantId, fileId },
        "files: SKIP_AV_SCAN=true — marked clean without scanning",
      );
      return;
    }

    storageKeyForScan = file.storageKey;
  });

  if (!storageKeyForScan) return;

  const queue = new Queue<{
    fileId: string;
    tenantId: string;
    storageKey: string;
  }>(AV_SCAN_QUEUE, { connection: redis });

  try {
    await queue.add(
      "scan",
      { fileId, tenantId, storageKey: storageKeyForScan },
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

  logger.info({ tenantId, fileId }, "files: av scan enqueued");
}

/**
 * Issue a presigned GET URL for a clean file.
 * Throws for pending, quarantined, scan_failed, or deleted files.
 */
export async function getDownloadUrl(
  db: DbOrTx,
  tenantId: string,
  fileId: string,
  inline = false,
): Promise<{ downloadUrl: string; downloadUrlExpiresAt: Date }> {
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
  const expiresAt = new Date(Date.now() + DOWNLOAD_URL_EXPIRY_SECONDS * 1000);

  const downloadUrl = await getSignedUrl(
    getS3ForSigning(),
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: file.storageKey,
      ResponseContentDisposition: inline
        ? `inline; filename="${file.originalName}"`
        : `attachment; filename="${file.originalName}"`,
    }),
    { expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS },
  );

  return { downloadUrl, downloadUrlExpiresAt: expiresAt };
}

/**
 * Soft-delete a file: sets scan_status to 'deleted' and asynchronously
 * removes the S3 object. Quota is released immediately.
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

  // Asynchronously delete the S3 object — fire-and-forget is intentional:
  // the row is already marked deleted; if S3 deletion fails, a separate
  // cleanup job will retry. We do not block the response on S3.
  void getS3()
    .send(
      new DeleteObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: storageKeyToDelete,
      }),
    )
    .catch((err: unknown) => {
      logger.warn(
        { tenantId, fileId, storageKey: storageKeyToDelete, err: String(err) },
        "files: S3 object deletion failed — will be retried by cleanup job",
      );
    });

  logger.info({ tenantId, fileId }, "files: file soft-deleted");
}

/**
 * Batch-delete S3 objects by storage key.
 * Used by the tenant-purge worker for GDPR hard-deletion.
 * Processes in chunks of 1000 (S3 DeleteObjects limit).
 * Errors per-chunk are caught and logged but do not propagate —
 * the caller should treat S3 failures as a storage-leak warning, not fatal.
 */
export async function deleteTenantFiles(storageKeys: string[]): Promise<void> {
  if (storageKeys.length === 0) return;
  const s3 = getS3();
  const CHUNK = 1000;
  for (let i = 0; i < storageKeys.length; i += CHUNK) {
    const chunk = storageKeys.slice(i, i + CHUNK);
    await s3
      .send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET,
          Delete: {
            Objects: chunk.map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      )
      .catch((err: unknown) => {
        logger.warn(
          { count: chunk.length, err: String(err) },
          "files: batch S3 deletion failed — storage may leak",
        );
      });
  }
  logger.info(
    { count: storageKeys.length },
    "files: tenant S3 objects deleted",
  );
}
