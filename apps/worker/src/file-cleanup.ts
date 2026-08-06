/**
 * file-cleanup.ts
 *
 * Recurring BullMQ job (every hour) that purges stale pending files:
 *  - Files with scan_status = 'pending' and created_at < now() - 24h
 *  - Deletes the on-disk file
 *  - Deletes the row from the files table
 *
 * Quota is implicit — it's the aggregate of active file rows.
 * Deleting the row automatically releases the used bytes from the aggregate.
 *
 * This handles the case where a client initiates an upload but never completes
 * it (client crash, network error, tab closed).
 */

import { Worker, Queue } from "bullmq";
import fsp from "node:fs/promises";
import { lt, eq, and, or } from "drizzle-orm";
import { db, files } from "@platform/db";
import { logger } from "@platform/logger";
import { resolveStoragePath } from "@platform/files";
import { connection } from "./queues.js";

const STALE_AFTER_HOURS = 24;
const QUEUE_NAME = "file-cleanup";
/** Max rows per cleanup run — prevents unbounded memory usage. */
const BATCH_LIMIT = 500;

// ── Cleanup processor ─────────────────────────────────────────────────────────

async function runCleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_HOURS * 60 * 60 * 1000);

  // Two categories of files to clean up in one query:
  //  1. scan_status = 'pending' AND created_at < cutoff
  //     → abandoned uploads (client never called confirmUpload)
  //  2. scan_status = 'deleted'
  //     → soft-deleted files whose on-disk deletion failed at delete-time;
  //        deleteFile() logged and deferred them here.
  const staleFiles = await db
    .select({
      id: files.id,
      tenantId: files.tenantId,
      storageKey: files.storageKey,
      scanStatus: files.scanStatus,
    })
    .from(files)
    .where(
      or(
        and(eq(files.scanStatus, "pending"), lt(files.createdAt, cutoff)),
        eq(files.scanStatus, "deleted"),
      ),
    )
    .limit(BATCH_LIMIT);

  if (staleFiles.length === 0) {
    logger.info({}, "file-cleanup: no stale files found");
    return;
  }

  logger.info(
    { count: staleFiles.length },
    "file-cleanup: processing stale files",
  );

  let purged = 0;
  let errors = 0;

  for (const file of staleFiles) {
    try {
      // Delete on-disk file (best-effort; row deletion still proceeds on error)
      try {
        await fsp.unlink(resolveStoragePath(file.storageKey));
      } catch (diskErr) {
        logger.warn(
          { tenantId: file.tenantId, fileId: file.id, err: String(diskErr) },
          "file-cleanup: on-disk deletion failed — will retry next run",
        );
      }

      // Hard-delete the row.  For 'deleted' rows this completes the soft-delete
      // lifecycle; for 'pending' rows it releases the quota reservation.
      await db.delete(files).where(eq(files.id, file.id));

      purged++;
      logger.info(
        {
          tenantId: file.tenantId,
          fileId: file.id,
          scanStatus: file.scanStatus,
        },
        "file-cleanup: file purged",
      );
    } catch (err) {
      errors++;
      logger.error(
        { tenantId: file.tenantId, fileId: file.id, err: String(err) },
        "file-cleanup: failed to purge file",
      );
    }
  }

  logger.info({ purged, errors }, "file-cleanup: run complete");
}

// ── BullMQ worker + recurring schedule ───────────────────────────────────────

export const fileCleanupWorker = new Worker(
  QUEUE_NAME,
  async () => {
    await runCleanup();
  },
  { connection },
);

fileCleanupWorker.on("failed", (_job, err) => {
  logger.error({ err: String(err) }, "file-cleanup: worker job failed");
});

/**
 * Schedule a recurring cleanup job (runs every hour).
 * Uses BullMQ's repeatable jobs so only one instance runs at a time even if
 * multiple worker processes are running.
 */
export async function scheduleFileCleanup(): Promise<void> {
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.add(
    "cleanup",
    {},
    {
      repeat: { pattern: "0 * * * *" }, // every hour on the hour
      jobId: "file-cleanup-recurring",
    },
  );
  await queue.close();
  logger.info({}, "file-cleanup: recurring job scheduled (every 1h)");
}

export async function stopFileCleanupWorker(): Promise<void> {
  await fileCleanupWorker.close();
}
