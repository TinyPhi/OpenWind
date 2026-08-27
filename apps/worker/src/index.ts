import { logger } from "@platform/logger";
import { closeRedis } from "@platform/redis";
import { startOutboxPoller, stopOutboxPoller } from "./outbox-poller.js";
import { stopAutomationWorker } from "./automation-worker.js";
import { startSlaScheduler, stopSlaScheduler } from "./sla-scheduler.js";
import { slaBreacher } from "./sla-breacher.js";
import { startAlertScheduler, stopAlertScheduler } from "./alert-scheduler.js";
import { alertWorker } from "./alert-worker.js";
import {
  startDueDateScheduler,
  stopDueDateScheduler,
} from "./due-date-scheduler.js";
import { dueDateWorker } from "./due-date-worker.js";
import { dueDateApproachingWorker } from "./due-date-approaching-worker.js";
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
import { stopConnectorOutboundWorker } from "./connector-outbound-worker.js";
import {
  startConnectorPollScheduler,
  stopConnectorPollScheduler,
} from "./connector-poll-scheduler.js";
import { stopConnectorPollWorker } from "./connector-poll-worker.js";
import { stopMentionResolutionWorker } from "./mention-resolution-worker.js";
import {
  scheduleAttachmentCleanup,
  stopAttachmentCleanupWorker,
} from "./attachment-cleanup.js";
import {
  scheduleAccessLogRetention,
  stopAccessLogRetentionWorker,
} from "./access-log-retention.js";

logger.info({}, "Worker process starting");

// Pollers (interval-based, must be explicitly started and stopped)
startOutboxPoller();
startSlaScheduler();
startAlertScheduler();
startHealthServer();
startDueDateScheduler();
startNotificationPoller();
startConnectorPollScheduler();

// Schedule recurring file cleanup (idempotent — safe to call on every restart)
void scheduleFileCleanup();
void scheduleAttachmentCleanup();
void scheduleAccessLogRetention();

// automationWorker, slaBreacher, avScanWorker, fileCleanupWorker,
// notificationWorker, notificationOutboundWorker, connectorOutboundWorker,
// connectorPollWorker all start processing on import above.

async function shutdown(): Promise<void> {
  logger.info({}, "Worker shutting down");
  await Promise.all([
    stopOutboxPoller(),
    stopSlaScheduler(),
    stopAlertScheduler(),
    stopDueDateScheduler(),
    stopNotificationPoller(),
    stopAutomationWorker(),
    slaBreacher.close(),
    alertWorker.close(),
    dueDateWorker.close(),
    dueDateApproachingWorker.close(),
    stopAvScanWorker(),
    stopFileCleanupWorker(),
    stopTenantPurgeWorker(),
    stopExportWorker(),
    stopHealthServer(),
    stopNotificationWorker(),
    stopNotificationOutboundWorker(),
    stopConnectorOutboundWorker(),
    stopConnectorPollScheduler(),
    stopConnectorPollWorker(),
    stopMentionResolutionWorker(),
    stopAttachmentCleanupWorker(),
    stopAccessLogRetentionWorker(),
    closeRedis(),
  ]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
