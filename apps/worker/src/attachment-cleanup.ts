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

import { Worker, Queue } from "@platform/telemetry";
import { lt, eq, and, inArray } from "drizzle-orm";
import { withTenantContext, attachments } from "@platform/db";
import { logger } from "@platform/logger";
import { connection } from "./queues.js";
import { listSweepTenants, forEachTenant } from "./tenant-sweep.js";

const QUEUE_NAME = "attachment-cleanup";
/** Max rows per cleanup run -- prevents unbounded memory usage. */
const BATCH_LIMIT = 500;
/** How long an 'expired' row survives before hard deletion. */
const EXPIRED_GRACE_HOURS = 1;

async function cleanupTenant(
  tenantId: string,
  now: Date,
): Promise<{ expired: number; deleted: number }> {
  return withTenantContext(tenantId, async (tx) => {
    // Sweeps both 'pending' (never uploaded) and 'uploading' (claimed by a PUT
    // that then crashed/dropped mid-request, before its own catch block could
    // release the claim back to 'pending') -- an "uploading" row past its
    // slot's own expiry is exactly as abandoned as a "pending" one (PR #472
    // review comment).
    const staleSlots = await tx
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          eq(attachments.tenantId, tenantId),
          inArray(attachments.status, ["pending", "uploading"]),
          lt(attachments.uploadExpiresAt, now),
        ),
      )
      .limit(BATCH_LIMIT);

    let expired = 0;
    if (staleSlots.length > 0) {
      // Conditional on status still being pending/uploading (matching the
      // SELECT above) -- without this, a slow-but-successful upload that
      // completes right at the TTL boundary, after this row was read but
      // before this UPDATE runs, would get its fresh "uploaded" status
      // clobbered back to "expired" (PR #472 review finding 3).
      const updated = await tx
        .update(attachments)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            eq(attachments.tenantId, tenantId),
            inArray(
              attachments.id,
              staleSlots.map((slot) => slot.id),
            ),
            inArray(attachments.status, ["pending", "uploading"]),
          ),
        )
        .returning({ id: attachments.id });
      expired = updated.length;
    }

    // Runs every cycle regardless of whether the expire pass above found
    // anything, otherwise a cycle with no NEW stale slots would skip this
    // delete pass forever and the table would grow without bound.
    const graceCutoff = new Date(
      now.getTime() - EXPIRED_GRACE_HOURS * 60 * 60 * 1000,
    );
    const removed = await tx
      .delete(attachments)
      .where(
        and(
          eq(attachments.tenantId, tenantId),
          eq(attachments.status, "expired"),
          lt(attachments.updatedAt, graceCutoff),
        ),
      )
      .returning({ id: attachments.id });

    return { expired, deleted: removed.length };
  });
}

// Per-tenant under withTenantContext (issue #1078): the worker runs as app_user, so a
// context-free cross-tenant query is filtered to zero rows (or errors) by RLS.
export async function runCleanup(): Promise<void> {
  const now = new Date();
  const sweepTenants = await listSweepTenants();
  const { results, failedTenantIds } = await forEachTenant(
    "attachment-cleanup",
    sweepTenants.map((t) => t.id),
    (tenantId) => cleanupTenant(tenantId, now),
  );

  let expired = 0;
  let deleted = 0;
  for (const result of results.values()) {
    expired += result.expired;
    deleted += result.deleted;
  }
  logger.info(
    {
      tenantCount: sweepTenants.length,
      expired,
      deleted,
      failedTenants: failedTenantIds.length,
    },
    "attachment-cleanup: sweep complete",
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
