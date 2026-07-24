import { Queue } from "bullmq";
import Redis from "ioredis";
import { env } from "@platform/config";

// Shared Redis connection for all queues.
// maxRetriesPerRequest: null is required for BullMQ workers — without it,
// transient Redis unavailability throws MaxRetriesPerRequestError and drops
// jobs instead of retrying.
export const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// attempts: 3 with exponential backoff, matching the SLA queue — without this,
// BullMQ defaults to attempts: 1, so a transient failure (or a downstream 429)
// fails the job immediately instead of backing off, adding retry pressure
// during an incident rather than damping it. See issue #123.
export const automationQueue = new Queue("automation", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
  },
});

// Default job options apply to every job added to this queue.
// attempts: 3 with exponential backoff means transient DB failures are retried
// before the job is considered failed and written to dead_letter_events.
export const slaQueue = new Queue("sla", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
  },
});

// AV scan queue — processes file upload scans (pending → clean|quarantined|scan_failed)
// attempts: 5 with exponential backoff (1s, 2s, 4s, 8s, 16s)
export const avScanQueue = new Queue("av-scan", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: { age: 3_600 }, // 1h
    removeOnFail: { age: 604_800 }, // 7d
  },
});

// File cleanup queue — purges stale pending uploads (runs every 1h via repeatable job)
export const fileCleanupQueue = new Queue("file-cleanup", { connection });

// Tenant purge queue — hard-deletes all tenant data after the GDPR delay expires.
// Jobs are added by the API's tenant lifecycle service with a configurable delay
// (default 30 days). concurrency=1 in the worker prevents DB contention.
export const tenantPurgeQueue = new Queue("tenant-purge", { connection });

// Export queue — generates CSV/xlsx/PDF for large entity list exports (> 5 000 rows).
// API enqueues via apps/api/src/lib/export-queue.ts using the same queue name.
export const exportQueue = new Queue("export", { connection });

// In-app notification hub (docs/specs/in-app-notification-hub.md).
// "notify" is distinct from @platform/notifications' "notifications" queue —
// that one is the pre-existing Novu template-based delivery path; this one is
// the new in-app notifier (recipient resolution + notifications/
// notification_recipients rows + live websocket push).
export const notifyQueue = new Queue("notify", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
  },
});

// Outbound handoff — the single seam to the externally-owned email/SMS/
// WhatsApp service (contract TBD). 3 attempts/exponential backoff matches the
// automation queue convention (issue #123).
export const notifyOutboundQueue = new Queue("notify-outbound", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
  },
});
