/**
 * attachment-cleanup.ts
 *
 * Recurring BullMQ job (every 5 minutes, matching the upload slot's own TTL)
 * that sweeps expired, never-completed attachment presign slots (ADR-012
 * Phase D, spec R8). Unlike file-cleanup.ts's 24h pending-file sweep, this
 * table never held a quota reservation to release (spec R2 -- quota is
 * enforced at upload-completion time via saveUpload, not at presign) so
 * this job only marks/removes stale rows, no disk or quota bookkeeping.
 *
 * Two-phase: mark-then-delete, not delete-on-sight. A newly-expired slot is
 * first flipped to 'expired' (keeps a short-lived trail in case an
 * in-flight upload request loses the race against this exact sweep --
 * attachments-upload.ts checks for that and 410s cleanly). Only once a row
 * has sat in 'expired' past its own grace period is it actually deleted,
 * which is what bounds the table's growth from a sustained
 * presign-and-abandon pattern (full-phase security review finding).
 */

import { Worker, Queue } from "bullmq";
import { lt, eq, and, inArray } from "drizzle-orm";
import { db, attachments } from "@platform/db";
import { logger } from "@platform/logger";
import { connection } from "./queues.js";

const QUEUE_NAME = "attachment-cleanup";
/** Max rows per cleanup run -- prevents unbounded memory usage. */
const BATCH_LIMIT = 500;
/** How long an 'expired' row survives before hard deletion. */
const EXPIRED_GRACE_HOURS = 1;

// No withTenantContext/explicit tenant_id filter here -- same accepted
// pattern as file-cleanup.ts's own cross-tenant sweep. Every write below
// targets an exact row by primary key (never returns row contents to a
// caller), so there's no cross-tenant data exposure; RLS still applies as
// defense-in-depth via the worker's configured DB role.
async function runCleanup(): Promise<void> {
  const now = new Date();

  // Sweeps both 'pending' (never uploaded) and 'uploading' (claimed by a PUT
  // that then crashed/dropped mid-request, before its own catch block could
  // release the claim back to 'pending') -- an "uploading" row past its
  // slot's own expiry is exactly as abandoned as a "pending" one (PR #472
  // review comment).
  const staleSlots = await db
    .select({ id: attachments.id, tenantId: attachments.tenantId })
    .from(attachments)
    .where(
      and(
        inArray(attachments.status, ["pending", "uploading"]),
        lt(attachments.uploadExpiresAt, now),
      ),
    )
    .limit(BATCH_LIMIT);

  if (staleSlots.length === 0) {
    logger.info({}, "attachment-cleanup: no stale slots found");
  } else {
    logger.info(
      { count: staleSlots.length },
      "attachment-cleanup: processing stale slots",
    );

    let purged = 0;
    let errors = 0;

    for (const slot of staleSlots) {
      try {
        // Conditional on status still being pending/uploading (matching the
        // SELECT above) -- without this, a slow-but-successful upload that
        // completes right at the TTL boundary, after this row was read but
        // before this UPDATE runs, would get its fresh "uploaded" status
        // clobbered back to "expired" (PR #472 review finding 3).
        await db
          .update(attachments)
          .set({ status: "expired", updatedAt: new Date() })
          .where(
            and(
              eq(attachments.id, slot.id),
              eq(attachments.tenantId, slot.tenantId),
              inArray(attachments.status, ["pending", "uploading"]),
            ),
          );
        purged++;
      } catch (err) {
        errors++;
        logger.error(
          { tenantId: slot.tenantId, attachmentId: slot.id, err: String(err) },
          "attachment-cleanup: failed to expire slot",
        );
      }
    }

    logger.info({ purged, errors }, "attachment-cleanup: expire pass complete");
  }

  // Runs every cycle regardless of whether the expire pass above found
  // anything -- an earlier version of this function `return`ed early when
  // staleSlots was empty, which meant a cycle with no NEW stale slots (the
  // common case once an initial spike settles) skipped this delete pass
  // forever, defeating the whole point of bounding table growth from a
  // sustained presign-and-abandon pattern (the bug this two-phase design
  // exists to fix).
  const graceCutoff = new Date(
    now.getTime() - EXPIRED_GRACE_HOURS * 60 * 60 * 1000,
  );
  // No tenantId filter here — global system sweep delete pass (see top-of-file comment)
  const deleted = await db
    .delete(attachments)
    .where(
      and(
        eq(attachments.status, "expired"),
        lt(attachments.updatedAt, graceCutoff),
      ),
    )
    .returning({ id: attachments.id });

  logger.info(
    { deleted: deleted.length },
    "attachment-cleanup: delete pass complete",
  );
}

export const attachmentCleanupWorker = new Worker(
  QUEUE_NAME,
  async () => {
    await runCleanup();
  },
  { connection },
);

attachmentCleanupWorker.on("failed", (_job, err) => {
  logger.error({ err: String(err) }, "attachment-cleanup: worker job failed");
});

/**
 * Schedule a recurring cleanup job (runs every 5 minutes, matching the
 * upload slot's own TTL -- a stale slot is never more than one interval
 * past expiry before being swept).
 */
export async function scheduleAttachmentCleanup(): Promise<void> {
  const queue = new Queue(QUEUE_NAME, { connection });
  await queue.add(
    "cleanup",
    {},
    {
      repeat: { pattern: "*/5 * * * *" },
      jobId: "attachment-cleanup-recurring",
    },
  );
  await queue.close();
  logger.info({}, "attachment-cleanup: recurring job scheduled (every 5m)");
}

export async function stopAttachmentCleanupWorker(): Promise<void> {
  await attachmentCleanupWorker.close();
}
