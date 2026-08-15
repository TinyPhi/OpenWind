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

// Ticket alerts (docs/specs/ticket-alerts.md) — personal reminder firing,
// deliberately its own queue/poller, independent of slaQueue/sla-scheduler.ts
// (see spec §V: the two must never be merged). Same defaultJobOptions as
// slaQueue for consistency.
export const ticketAlertsQueue = new Queue("ticket-alerts", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
  },
});

// Due date (docs/specs/due-date.md) — overdue-trigger firing, deliberately
// its own queue/poller, independent of slaQueue/sla-scheduler.ts and
// ticketAlertsQueue/alert-scheduler.ts (see spec §V: never merged into
// shared code). Same defaultJobOptions as slaQueue for consistency.
export const dueDateQueue = new Queue("due-date", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
  },
});

// ui-feature-checklist-and-rules.md §2.8 — "due date approaching" (2 days
// prior) warning. A sibling of dueDateQueue, not a merge into it: it fires at
// a different offset (dueDate - 2 days, not dueDate itself) and feeds a
// different outbox event type, but shares due-date-scheduler.ts's polling
// tick and due-date.md's TOCTOU-guard pattern (see due-date-approaching-worker.ts).
export const dueDateApproachingQueue = new Queue("due-date-approaching", {
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

// Connector outbound delivery (ADR-009 Decision #9, issue #365) — delivers a
// signed event payload to a connector's configured target URL, with its OWN
// retry configuration rather than reusing notifyOutboundQueue's 3-attempts/1s
// pattern above. That pattern totals ~7s of retry window (1s+2s+4s), sized for
// an internal service outage measured in seconds; a third-party connector
// endpoint can legitimately be down or rate-limiting for far longer, and the
// ADR's own research cites a Stripe/Svix-class tail of hours to ~27 hours as
// the right target — this queue's config is deliberately NOT the same as the
// one above.
//
// Worst-case cumulative delay across `attempts` exponential-backoff retries,
// sum(delay * 2^i) for i in 0..attempts-1 = delay * (2^attempts - 1):
//   45_000ms * (2^11 - 1) = 45_000 * 2047 = 92,115,000ms ≈ 25.6 hours
// 11 attempts / 45s base delay lands just under the ~27h reference point
// (Svix's own default schedule totals ~27.5h across 8 retries with
// non-uniform steps; a plain exponential series with these two numbers is
// the closest clean match BullMQ's uniform exponential backoff can express).
export const connectorOutboundQueue = new Queue("connector-outbound", {
  connection,
  defaultJobOptions: {
    attempts: 11,
    backoff: { type: "exponential", delay: 45_000 },
  },
});

// Connector inbound gateway (ADR-009 Decision #3, issue #364) — the
// transformed event from a verified inbound webhook, published here by
// apps/api's webhook route for downstream processing. Simple internal-job
// retry semantics (matching automationQueue/notifyOutboundQueue's convention)
// since a failure here is this platform's own processing failure, not a
// third-party endpoint being down — unlike connectorOutboundQueue above,
// there's no case for an hours-long retry tail. No consumer exists yet: this
// issue is the producer/gateway side only (see phase-3-primer.md's Stage 2
// scope note); a Worker consuming this queue is separate, not-yet-built work
// for whenever #368's connectors give it something to do.
export const connectorInboundQueue = new Queue("connector-inbound", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
  },
});
