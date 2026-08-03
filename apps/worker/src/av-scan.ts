/**
 * av-scan.ts
 *
 * BullMQ processor for the "av-scan" queue.
 *
 * For each job:
 *  1. Fetch the file row — skip if already clean/quarantined/deleted (idempotent)
 *  2. Download the S3 object into a Buffer
 *  3. Send bytes to ClamAV via raw TCP (INSTREAM protocol on port 3310)
 *  4. Transition scan_status: pending → clean | quarantined | scan_failed
 *  5. On quarantine: alert tenant admin via @platform/notifications
 *  6. On scan_failed after max retries: emit system.error outbox event
 *
 * Retry schedule (exponential backoff): 1s, 2s, 4s, 8s, 16s (max 5 attempts).
 * The scan_failed status is only written on the final attempt.
 */

import net from "node:net";
import { Worker } from "bullmq";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { eq, and } from "drizzle-orm";
import { db, files, outboxEvents, isTenantActive } from "@platform/db";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { sendNotification } from "@platform/notifications";
import { connection } from "./queues.js";

// ── Types ──────────────────────────────────────────────────────────────────────

type AvScanJob = {
  fileId: string;
  tenantId: string;
  storageKey: string;
};

// ── S3 client (lazily initialised — avoids top-level instantiation in tests) ──

let _s3: S3Client | undefined;
function getS3(): S3Client {
  _s3 ??= new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: "us-east-1",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });
  return _s3;
}

// ── ClamAV INSTREAM protocol ──────────────────────────────────────────────────

/**
 * Scan `data` against ClamAV using the INSTREAM protocol.
 * Returns "clean" or "infected".
 * Throws on connection failure or protocol error (triggers job retry).
 */
function scanWithClamav(data: Buffer): Promise<"clean" | "infected"> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let response = "";

    socket.connect(env.CLAMAV_PORT, env.CLAMAV_HOST, () => {
      // INSTREAM: zINSTREAM\0, then chunks as 4-byte big-endian length + data, then 4 zero bytes
      socket.write("zINSTREAM\0");

      const chunkSize = 8192;
      let offset = 0;
      while (offset < data.length) {
        const chunk = data.slice(offset, offset + chunkSize);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length, 0);
        socket.write(len);
        socket.write(chunk);
        offset += chunkSize;
      }

      // Send terminator
      const terminator = Buffer.alloc(4);
      terminator.writeUInt32BE(0, 0);
      socket.write(terminator);
    });

    socket.on("data", (chunk) => {
      response += chunk.toString();
    });

    socket.on("end", () => {
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

    socket.on("error", (err) => {
      reject(err);
    });

    socket.setTimeout(30_000, () => {
      socket.destroy();
      reject(new Error("ClamAV connection timed out"));
    });
  });
}

// ── Worker ────────────────────────────────────────────────────────────────────

export const avScanWorker = new Worker<AvScanJob>(
  "av-scan",
  async (job) => {
    const { fileId, tenantId, storageKey } = job.data;

    logger.info({ tenantId, fileId, jobId: job.id }, "av-scan: job started");

    const active = await isTenantActive(tenantId);
    if (!active) {
      logger.warn(
        { tenantId, fileId, jobId: job.id },
        "av-scan aborted: tenant is not active",
      );
      return;
    }

    // Idempotency: skip if no longer pending.
    // Also fetch uploadedBy so we can notify the uploader on quarantine.
    const [file] = await db
      .select({
        id: files.id,
        scanStatus: files.scanStatus,
        uploadedBy: files.uploadedBy,
      })
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)))
      .limit(1);

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

    // Download from S3
    const s3Obj = await getS3().send(
      new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey }),
    );

    if (!s3Obj.Body) {
      throw new Error(`av-scan: empty S3 body for key ${storageKey}`);
    }

    // Collect stream into Buffer
    const chunks: Buffer[] = [];
    for await (const chunk of s3Obj.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    const fileBuffer = Buffer.concat(chunks);

    // Scan
    const verdict = await scanWithClamav(fileBuffer);

    if (verdict === "clean") {
      await db
        .update(files)
        .set({ scanStatus: "clean", updatedAt: new Date() })
        .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

      logger.info({ tenantId, fileId }, "av-scan: file is clean");
      return;
    }

    // Infected → quarantine
    await db
      .update(files)
      .set({ scanStatus: "quarantined", updatedAt: new Date() })
      .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

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
        await db
          .update(files)
          .set({ scanStatus: "scan_failed", updatedAt: new Date() })
          .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));

        await db.insert(outboxEvents).values({
          tenantId,
          eventType: "system.error",
          version: 1,
          payload: {
            source: "av-scan-worker",
            fileId,
            error: String(err),
            attemptsMade: job.attemptsMade,
          },
          // system.error isn't an automation trigger (outbox-poller.ts's
          // allowlist excludes it) and has no other consumer — dead-letter by
          // design at write time, rather than leaving delivered_at NULL forever
          // (which would make it look like an undelivered row nothing ever picks up).
          deliveredAt: new Date(),
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
