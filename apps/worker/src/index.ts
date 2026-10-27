import "@platform/telemetry/instrumentation.js";
import { startErrorTracking } from "@platform/telemetry";
startErrorTracking();
import { env } from "@platform/config";
import { setMandatoryFieldsMode } from "@platform/entity-engine";
// docs/specs/mandatory-ticket-fields.md: log or reject workflow records missing a mandatory
// value. The engine reads no config itself.
setMandatoryFieldsMode(env.MANDATORY_FIELDS_MODE);
import { registerFallbackAssigneeResolver } from "@platform/automation-engine";
import { resolveFallbackAssignee } from "./fallback-assignee.js";
// Who gets an automation-created ticket when the rule names nobody (spec R7).
registerFallbackAssigneeResolver(resolveFallbackAssignee);
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
import { stopSupersetCacheFlushWorker } from "./superset-cache-flush.js";
import { stopSupersetErasureWorker } from "./superset-erasure.js";
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
import {
  scheduleUsageMetering,
  stopUsageMeteringWorker,
} from "./usage-metering.js";
import {
  scheduleRetentionArchival,
  stopRetentionArchivalWorker,
} from "./retention-archival.js";
import {
  scheduleZitadelKeyExpiryCheck,
  stopZitadelKeyExpiryWorker,
} from "./zitadel-key-expiry.js";
import {
  startScheduleTickWorker,
  stopScheduleTickWorker,
} from "./schedule-tick-worker.js";
import {
  startOncallRotationWorker,
  stopOncallRotationWorker,
} from "./oncall-rotation-worker.js";
import {
  startOrgDirectorySyncScheduler,
  stopOrgDirectorySyncScheduler,
} from "./org-directory-sync-scheduler.js";
import { stopSandboxProvisioningWorker } from "./sandbox-provisioning-worker.js";
import { stopSandboxResetWorker } from "./sandbox-reset-worker.js";
import { stopSandboxDeleteWorker } from "./sandbox-delete-worker.js";

logger.info({}, "Worker process starting");

// Pollers (interval-based, must be explicitly started and stopped)
startOutboxPoller();
startSlaScheduler();
startAlertScheduler();
startHealthServer();
startDueDateScheduler();
startNotificationPoller();
startConnectorPollScheduler();
startScheduleTickWorker();
startOncallRotationWorker();
startOrgDirectorySyncScheduler();

// Schedule recurring file cleanup (idempotent — safe to call on every restart)
void scheduleFileCleanup();
void scheduleAttachmentCleanup();
void scheduleAccessLogRetention();
void scheduleUsageMetering();
void scheduleRetentionArchival();
void scheduleZitadelKeyExpiryCheck();

// automationWorker, slaBreacher, avScanWorker, fileCleanupWorker,
// notificationWorker, notificationOutboundWorker, connectorOutboundWorker,
// connectorPollWorker, sandboxProvisioningWorker, sandboxResetWorker, sandboxDeleteWorker
// all start processing on import above
// (each module's own `new Worker(...)` call runs as a side effect of being imported).

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
    stopSupersetCacheFlushWorker(),
    stopSupersetErasureWorker(),
    stopHealthServer(),
    stopNotificationWorker(),
    stopNotificationOutboundWorker(),
    stopConnectorOutboundWorker(),
    stopConnectorPollScheduler(),
    stopConnectorPollWorker(),
    stopMentionResolutionWorker(),
    stopAttachmentCleanupWorker(),
    stopAccessLogRetentionWorker(),
    stopUsageMeteringWorker(),
    stopRetentionArchivalWorker(),
    stopZitadelKeyExpiryWorker(),
    stopScheduleTickWorker(),
    stopOncallRotationWorker(),
    stopOrgDirectorySyncScheduler(),
    stopSandboxProvisioningWorker(),
    stopSandboxResetWorker(),
    stopSandboxDeleteWorker(),
    closeRedis(),
  ]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
