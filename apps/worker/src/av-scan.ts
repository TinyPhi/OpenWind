/**
 * av-scan.ts
 *
 * BullMQ processor for the "av-scan" queue.
 *
 * For each job:
 *  1. Fetch the file row — skip if already clean/quarantined/deleted (idempotent)
 *  2. Stream the on-disk file to ClamAV via raw TCP (INSTREAM protocol on port 3310)
 *  3. Transition scan_status: pending → clean | quarantined | scan_failed
 *  4. On quarantine: alert tenant admin via @platform/notifications
 *  5. On scan_failed after max retries: emit system.error outbox event
 *
 * Retry schedule (exponential backoff): 1s, 2s, 4s, 8s, 16s (max 5 attempts).
 * The scan_failed status is only written on the final attempt.
 */

import fsp, { type FileHandle } from "node:fs/promises";
import net from "node:net";
import { Worker } from "bullmq";
import { eq, and } from "drizzle-orm";
import { files, outboxEvents, withTenantContext } from "@platform/db";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { sendNotification } from "@platform/notifications";
import { resolveStoragePath } from "@platform/files";
import { connection } from "./queues.js";
import { validateActiveTenant } from "./tenant-guard.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type AvScanJob = {
  fileId: string;
  tenantId: string;
  storageKey: string;
};

// ── ClamAV INSTREAM protocol ──────────────────────────────────────────────────

/**
 * Scan an open file handle against ClamAV using the INSTREAM protocol.
 * Accepts a FileHandle (not a path) so the caller's resolveStoragePath
 * validation is the only route to this function — no arbitrary path can
 * reach the socket.
 * Returns "clean" or "infected".
 * Throws on connection/read failure or protocol error (triggers job retry).
 */
function scanWithClamav(handle: FileHandle): Promise<"clean" | "infected"> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let response = "";
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fileStream.destroy();
      reject(err);
    };

    // Created in paused mode — no listeners attached yet, so it can't start
    // flowing (and writing to the socket) until we explicitly let it below.
    const fileStream = handle.createReadStream({ highWaterMark: 8192 });
    fileStream.pause();
    fileStream.on("error", fail);

    socket.connect(env.CLAMAV_PORT, env.CLAMAV_HOST, () => {
      // INSTREAM: zINSTREAM\0, then chunks as 4-byte big-endian length + data, then 4 zero bytes.
      // The header MUST reach ClamAV before any chunk does — only start
      // consuming the file stream once the header write has been queued,
      // otherwise (if the disk read completes before the TCP handshake)
      // chunks can be written to the socket ahead of the header, which
      // ClamAV rejects by closing the connection (surfaces as write EPIPE
      // on our next write, since it's now writing into a closed socket).
      socket.write("zINSTREAM\0");

      fileStream.on("data", (chunk: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length, 0);
        socket.write(len);
        socket.write(chunk);
      });

      fileStream.on("end", () => {
        const terminator = Buffer.alloc(4);
        terminator.writeUInt32BE(0, 0);
        socket.write(terminator);
      });

      fileStream.resume();
    });

    socket.on("data", (chunk) => {
      response += chunk.toString();
    });

    socket.on("end", () => {
      if (settled) return;
      settled = true;
      // Response format: "stream: OK\0" or "stream: <virus name> FOUND\0"
      const clean = response.includes("OK");
      const infected = response.includes("FOUND");
      if (clean && !infected) {
        resolve("clean");
      } else if (infected) {
        resolve("infected");
      } else {
        reject(new Error(`Unexpected ClamAV response: ${response}`));
      }
    });

    socket.on("error", fail);

    socket.setTimeout(30_000, () => {
      fail(new Error("ClamAV connection timed out"));
    });
  });
}

// ── Worker ────────────────────────────────────────────────────────────────────

export const avScanWorker = new Worker<AvScanJob>(
  "av-scan",
  async (job) => {
    const { fileId, tenantId, storageKey } = job.data;

    logger.info({ tenantId, fileId, jobId: job.id }, "av-scan: job started");

    const active = await validateActiveTenant(tenantId, "av-scan", {
      fileId,
      jobId: job.id,
    });
    if (!active) return;

    // Idempotency: skip if no longer pending.
    // Also fetch uploadedBy so we can notify the uploader on quarantine.
    const [file] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          id: files.id,
          scanStatus: files.scanStatus,
          uploadedBy: files.uploadedBy,
        })
        .from(files)
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
        .limit(1),
    );

    if (!file) {
      logger.warn(
        { tenantId, fileId },
        "av-scan: file row not found — skipping",
      );
      return;
    }

    if (file.scanStatus !== "pending") {
      logger.info(
        { tenantId, fileId, scanStatus: file.scanStatus },
        "av-scan: file already processed — skipping (idempotent)",
      );
      return;
    }

    // Open a file handle from the already-validated storage path so scanWithClamav
    // never receives a raw path string — resolveStoragePath's containment check
    // is the only route to this handle.
    const handle = await fsp.open(resolveStoragePath(storageKey), "r");
    const verdict = await scanWithClamav(handle).finally(() => handle.close());

    if (verdict === "clean") {
      await withTenantContext(tenantId, (tx) =>
        tx
          .update(files)
          .set({ scanStatus: "clean", updatedAt: new Date() })
          .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId))),
      );

      logger.info({ tenantId, fileId }, "av-scan: file is clean");
      return;
    }

    // Infected → quarantine
    await withTenantContext(tenantId, (tx) =>
      tx
        .update(files)
        .set({ scanStatus: "quarantined", updatedAt: new Date() })
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId))),
    );

    logger.warn(
      { tenantId, fileId, storageKey },
      "av-scan: file quarantined — virus detected",
    );

    // Notify the file's uploader — they need to know their file was quarantined.
    // Using "system" was wrong: sendNotification requires a real userId to route
    // the notification via Novu.  The uploader (uploadedBy) is the most relevant
    // recipient and is available from the file row already fetched above.
    try {
      await sendNotification(
        connection,
        tenantId,
        file.uploadedBy,
        "file.quarantined",
        {
          fileId,
          storageKey,
        },
      );
    } catch (notifyErr) {
      // Non-fatal: log and continue — the file is already quarantined
      logger.warn(
        { tenantId, fileId, err: String(notifyErr) },
        "av-scan: failed to send quarantine notification",
      );
    }
  },
  {
    connection,
    concurrency: 4,
    // Failure handler — on final attempt, write scan_failed and emit system.error
    // (BullMQ calls this after all retries are exhausted)
  },
);

avScanWorker.on("failed", (job, err) => {
  if (!job) return;
  const { fileId, tenantId } = job.data;
  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);

  logger.error(
    { tenantId, fileId, attempt: job.attemptsMade, err: String(err) },
    "av-scan: job failed",
  );

  if (isFinalAttempt) {
    // Write scan_failed status and emit system.error outbox event
    void (async () => {
      try {
        await withTenantContext(tenantId, async (tx) => {
          await tx
            .update(files)
            .set({ scanStatus: "scan_failed", updatedAt: new Date() })
            .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

          await tx.insert(outboxEvents).values({
            tenantId,
            eventType: "system.error",
            version: 1,
            payload: {
              eventType: "system.error",
              version: 1,
              tenantId,
              context: {
                source: "av-scan-worker",
                fileId,
                error: String(err),
                attemptsMade: job.attemptsMade,
              },
              reason: `AV scan failed for file ${fileId}: ${String(err)}`,
            },
            // system.error isn't an automation trigger (outbox-poller.ts's
            // allowlist excludes it) and has no other consumer — dead-letter by
            // design at write time, rather than leaving delivered_at NULL forever
            // (which would make it look like an undelivered row nothing ever picks up).
            deliveredAt: new Date(),
          });
        });
      } catch (writeErr) {
        logger.error(
          { tenantId, fileId, writeErr: String(writeErr) },
          "av-scan: failed to write scan_failed status",
        );
      }
    })();
  }
});

export async function stopAvScanWorker(): Promise<void> {
  await avScanWorker.close();
}
