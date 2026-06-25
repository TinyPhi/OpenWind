import { logger } from "@platform/logger";
import { closeRedis } from "@platform/redis";
import { startOutboxPoller, stopOutboxPoller } from "./outbox-poller.js";
import { stopAutomationWorker } from "./automation-worker.js";
import { startSlaScheduler, stopSlaScheduler } from "./sla-scheduler.js";
import { slaBreacher } from "./sla-breacher.js";
import { stopAvScanWorker } from "./av-scan.js";
import { scheduleFileCleanup, stopFileCleanupWorker } from "./file-cleanup.js";
import { stopTenantPurgeWorker } from "./tenant-purge.js";
import { stopExportWorker } from "./export-worker.js";

logger.info({}, "Worker process starting");

// Pollers (interval-based, must be explicitly started and stopped)
startOutboxPoller();
startSlaScheduler();

// Schedule recurring file cleanup (idempotent — safe to call on every restart)
void scheduleFileCleanup();

// automationWorker, slaBreacher, avScanWorker, fileCleanupWorker all
// start processing on import above.

async function shutdown(): Promise<void> {
  logger.info({}, "Worker shutting down");
  await Promise.all([
    stopOutboxPoller(),
    stopSlaScheduler(),
    stopAutomationWorker(),
    slaBreacher.close(),
    stopAvScanWorker(),
    stopFileCleanupWorker(),
    stopTenantPurgeWorker(),
    stopExportWorker(),
    closeRedis(),
  ]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
