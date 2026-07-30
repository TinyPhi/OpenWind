import { logger } from "@platform/logger";
import { closeRedis } from "@platform/redis";
import { startOutboxPoller, stopOutboxPoller } from "./outbox-poller.js";
import { stopAutomationWorker } from "./automation-worker.js";
import { startSlaScheduler, stopSlaScheduler } from "./sla-scheduler.js";
import { slaBreacher } from "./sla-breacher.js";
import { startAlertScheduler, stopAlertScheduler } from "./alert-scheduler.js";
import { alertWorker } from "./alert-worker.js";
import { stopAvScanWorker } from "./av-scan.js";
import { scheduleFileCleanup, stopFileCleanupWorker } from "./file-cleanup.js";
import { stopTenantPurgeWorker } from "./tenant-purge.js";
import { stopExportWorker } from "./export-worker.js";
import { startHealthServer, stopHealthServer } from "./health-server.js";
import {
  startNotificationPoller,
  stopNotificationPoller,
} from "./notification-poller.js";
import { stopNotificationWorker } from "./notification-worker.js";
import { stopNotificationOutboundWorker } from "./notification-outbound-worker.js";

logger.info({}, "Worker process starting");

// Pollers (interval-based, must be explicitly started and stopped)
startOutboxPoller();
startSlaScheduler();
startAlertScheduler();
startHealthServer();
startNotificationPoller();

// Schedule recurring file cleanup (idempotent — safe to call on every restart)
void scheduleFileCleanup();

// automationWorker, slaBreacher, avScanWorker, fileCleanupWorker,
// notificationWorker, notificationOutboundWorker all start processing on
// import above.

async function shutdown(): Promise<void> {
  logger.info({}, "Worker shutting down");
  await Promise.all([
    stopOutboxPoller(),
    stopSlaScheduler(),
    stopAlertScheduler(),
    stopNotificationPoller(),
    stopAutomationWorker(),
    slaBreacher.close(),
    alertWorker.close(),
    stopAvScanWorker(),
    stopFileCleanupWorker(),
    stopTenantPurgeWorker(),
    stopExportWorker(),
    stopHealthServer(),
    stopNotificationWorker(),
    stopNotificationOutboundWorker(),
    closeRedis(),
  ]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
