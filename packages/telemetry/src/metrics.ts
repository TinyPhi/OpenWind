import { metrics } from "@opentelemetry/api";
import { Queue } from "./bullmq.js";
import { getRedis } from "@platform/redis";
import { env } from "@platform/config";
import { prometheusExporter } from "./instrumentation.js";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { SCHEDULE_DURATION_BUCKETS_MS } from "./schedule-duration-buckets.js";
import {
  NOTIFICATION_DISPATCH_BUCKETS_SECONDS,
  ONCALL_RESOLUTION_BUCKETS_SECONDS,
} from "./oncall-duration-buckets.js";

const meter = metrics.getMeter("openwind-metrics");

// 1. HTTP Request Latency (Histogram)
export const httpRequestDuration = meter.createHistogram(
  "http_request_duration_seconds",
  {
    description: "HTTP request duration in seconds",
  },
);

// 2. HTTP Requests Total (Counter)
export const httpRequestsTotal = meter.createCounter("http_requests_total", {
  description: "Total number of HTTP requests",
});

// 3. Queue Depths (Observable Gauge)
const queueNames = [
  "automation",
  "sla",
  "av-scan",
  "file-cleanup",
  "tenant-purge",
  "export",
  "notify",
  "ticket-alerts",
  "due-date",
  "due-date-approaching",
  "notify-outbound",
  "connector-outbound",
  "connector-inbound",
  "connector-poll",
  "mention-resolution",
];

// Cache Queue instances to avoid re-creating them on every scrape
const queueCache = new Map<string, Queue>();

function getQueue(name: string): Queue {
  let q = queueCache.get(name);
  if (!q) {
    q = new Queue(name, { connection: getRedis() });
    queueCache.set(name, q);
  }
  return q;
}

const queueDepthGauge = meter.createObservableGauge("bullmq_queue_depth", {
  description: "BullMQ queue depths",
});

queueDepthGauge.addCallback(async (observableResult) => {
  for (const name of queueNames) {
    try {
      const q = getQueue(name);
      const counts = await q.getJobCounts();

      observableResult.observe(counts.active ?? 0, {
        queue_name: name,
        status: "active",
      });
      observableResult.observe(counts.waiting ?? 0, {
        queue_name: name,
        status: "waiting",
      });
      observableResult.observe(counts.delayed ?? 0, {
        queue_name: name,
        status: "delayed",
      });
      observableResult.observe(counts.failed ?? 0, {
        queue_name: name,
        status: "failed",
      });
    } catch {
      // Don't crash metric collection if one queue fails
    }
  }
});

const degradedTenantsGauge = meter.createObservableGauge(
  "billing_degraded_tenants",
  {
    description: "Number of currently degraded tenants by reason",
  },
);

degradedTenantsGauge.addCallback(async (observableResult) => {
  try {
    const redis = getRedis();
    const keys = await redis.keys("degraded:*");

    let apiCallsCount = 0;
    let storageCount = 0;
    let aiTokensCount = 0;

    for (const key of keys) {
      const members = await redis.smembers(key);
      if (members.includes("api_calls")) apiCallsCount++;
      if (members.includes("storage")) storageCount++;
      if (members.includes("ai_tokens")) aiTokensCount++;
    }

    observableResult.observe(apiCallsCount, { reason: "api_calls" });
    observableResult.observe(storageCount, { reason: "storage" });
    observableResult.observe(aiTokensCount, { reason: "ai_tokens" });
  } catch {
    // Ignore redis/telemetry errors during scrape callbacks
  }
});

const tenantUsageGauge = meter.createObservableGauge("billing_tenant_usage", {
  description: "Daily usage counters per tenant",
});

tenantUsageGauge.addCallback(async (observableResult) => {
  try {
    const redis = getRedis();
    const todayStr = new Date().toISOString().split("T")[0];
    const keys = await redis.keys("usage:*:*:*");

    for (const key of keys) {
      const parts = key.split(":");
      if (parts.length === 4) {
        const [, tenantId, dateStr, metricName] = parts;
        if (dateStr === todayStr && tenantId && metricName) {
          const valStr = await redis.get(key);
          if (valStr) {
            const value = parseInt(valStr, 10);
            if (!isNaN(value)) {
              observableResult.observe(value, {
                tenant_id: tenantId,
                metric: metricName,
              });
            }
          }
        }
      }
    }
  } catch {
    // Ignore redis/telemetry errors during scrape callbacks
  }
});

// docs/specs/oncall-routing.md T39-T41 — on-call routing observability.
// openwind_oncall_resolutions_total is incremented directly by
// packages/automation-engine/src/actions/resolve-oncall.ts at each outcome.
export const oncallResolutionsTotal = meter.createCounter(
  "openwind_oncall_resolutions_total",
  {
    description:
      "Outcomes of resolve_oncall action executions, by outcome and assigned tier",
  },
);

// docs/specs/oncall-routing.md T27-T31/T39 — severity-based notification
// dispatch observability. Incremented directly by
// packages/automation-engine/src/actions/dispatch-severity-notification.ts:
// one increment per (channel, outcome) pair per action execution, so a
// partial-failure run (one channel ok, one channel_failed) reports both.
export const notificationDispatchTotal = meter.createCounter(
  "openwind_notification_dispatch_total",
  {
    description:
      "Per-channel outcomes of dispatch_severity_notification action executions",
  },
);

// docs/oncall-routing-design.md §9.3 -- duration histograms and the policy
// match counter. Seconds, so the bucket boundaries are explicit (see
// oncall-duration-buckets.ts). The resolution histogram is labelled by
// `outcome` to match openwind_oncall_resolutions_total (the design says
// `result`); tenant is not a label.
export const oncallResolutionDurationSeconds = meter.createHistogram(
  "openwind_oncall_resolution_duration_seconds",
  {
    description:
      "Time for a resolve_oncall action to reach an outcome, in seconds, by outcome",
    advice: { explicitBucketBoundaries: ONCALL_RESOLUTION_BUCKETS_SECONDS },
  },
);
export const notificationDispatchDurationSeconds = meter.createHistogram(
  "openwind_notification_dispatch_duration_seconds",
  {
    description:
      "Time to dispatch one channel of a dispatch_severity_notification action, in seconds, by channel",
    advice: { explicitBucketBoundaries: NOTIFICATION_DISPATCH_BUCKETS_SECONDS },
  },
);
export const notificationPolicyMatchTotal = meter.createCounter(
  "openwind_notification_policy_match_total",
  {
    description:
      "Where in the specificity chain a dispatch_severity_notification policy match landed (matched_at)",
  },
);

// Coverage-gap gauge: resolve-oncall.ts maintains a per-tenant Redis SET of
// team ids currently in a coverage-gap state (oncall.no_schedule, including
// R8b's exhausted-cascade case) — added when a gap is detected, removed on
// the next successful auto-assign for that team. Same idiom as
// billing_degraded_tenants/billing_tenant_usage above (scrape-time
// redis.keys() scan — the redis.keys() perf fix tracked in issue #4 covers
// all of these together, not just this one).
const oncallCoverageGapGauge = meter.createObservableGauge(
  "openwind_oncall_coverage_gap_teams",
  {
    description:
      "Number of teams currently in an on-call coverage gap, per tenant",
  },
);

oncallCoverageGapGauge.addCallback(async (observableResult) => {
  try {
    const redis = getRedis();
    const keys = await redis.keys("oncall:coverage_gap:*");
    for (const key of keys) {
      const tenantId = key.split(":")[2];
      if (!tenantId) continue;
      const count = await redis.scard(key);
      observableResult.observe(count, { tenant_id: tenantId });
    }
  } catch {
    // Ignore redis/telemetry errors during scrape callbacks
  }
});

// Zitadel machine-key expiry (docs/deployment-hardening.md, "Zitadel machine-key rotation").
// apps/worker/src/zitadel-key-expiry.ts leaves its latest result under this one key; reading it
// at scrape time keeps an alert possible even when the expiring key is the one email depends on.
const ZITADEL_KEY_EXPIRY_REPORT_KEY = "ops:zitadel-key-expiry:report";

const ZITADEL_KEY_NAMES = new Set([
  "management",
  "provisioning",
  "notification",
]);
const ZITADEL_KEY_STATUS_RE =
  /^(ok|warn_(30|14|7|3|1)|expired|long_lived|never_expires|missing|unknown)$/;

interface ZitadelKeyReport {
  checkedAt: number;
  rows: { name: string; status: string; expiresAt: string | null }[];
}

// Only well-formed rows count: a stray value in Redis must not invent label values.
async function readZitadelKeyReport(): Promise<ZitadelKeyReport | null> {
  const raw = await getRedis().get(ZITADEL_KEY_EXPIRY_REPORT_KEY);
  if (!raw) return null;
  // JSON.parse returns any; the shape is untrusted Redis content, so every field is
  // type-checked below before use.
  const parsed = JSON.parse(raw) as {
    checkedAt?: unknown;
    rows?: { name?: unknown; status?: unknown; expiresAt?: unknown }[];
  };
  const checkedAt =
    typeof parsed.checkedAt === "string" ? Date.parse(parsed.checkedAt) : NaN;
  if (Number.isNaN(checkedAt)) return null;
  const rows = (parsed.rows ?? []).flatMap((r) =>
    typeof r.name === "string" &&
    ZITADEL_KEY_NAMES.has(r.name) &&
    typeof r.status === "string" &&
    ZITADEL_KEY_STATUS_RE.test(r.status)
      ? [
          {
            name: r.name,
            status: r.status,
            expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : null,
          },
        ]
      : [],
  );
  return { checkedAt, rows };
}

const zitadelKeyDaysGauge = meter.createObservableGauge(
  "openwind_zitadel_key_days_remaining",
  {
    description:
      "Days until each configured Zitadel machine key expires, computed at scrape time (absent when it never expires or could not be checked)",
  },
);

zitadelKeyDaysGauge.addCallback(async (observableResult) => {
  try {
    const report = await readZitadelKeyReport();
    for (const row of report?.rows ?? []) {
      const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : NaN;
      if (Number.isNaN(expiresAt)) continue;
      observableResult.observe((expiresAt - Date.now()) / 86_400_000, {
        key: row.name,
      });
    }
  } catch {
    // Ignore redis/telemetry errors during scrape callbacks
  }
});

const zitadelKeyStatusGauge = meter.createObservableGauge(
  "openwind_zitadel_key_status",
  {
    description:
      "1 for each configured Zitadel machine key's current status (ok, warn_N, expired, long_lived, never_expires, missing, unknown)",
  },
);

zitadelKeyStatusGauge.addCallback(async (observableResult) => {
  try {
    const report = await readZitadelKeyReport();
    for (const row of report?.rows ?? []) {
      observableResult.observe(1, { key: row.name, status: row.status });
    }
  } catch {
    // Ignore redis/telemetry errors during scrape callbacks
  }
});

// Alert when this grows past ~36 h: the daily check has stopped, so the two gauges above are
// no longer being refreshed (the report itself expires after 3 days).
const zitadelKeyCheckAgeGauge = meter.createObservableGauge(
  "openwind_zitadel_key_check_age_seconds",
  { description: "Seconds since the last Zitadel machine-key expiry check" },
);

zitadelKeyCheckAgeGauge.addCallback(async (observableResult) => {
  try {
    const report = await readZitadelKeyReport();
    if (report) {
      observableResult.observe((Date.now() - report.checkedAt) / 1000);
    }
  } catch {
    // Ignore redis/telemetry errors during scrape callbacks
  }
});

const serializer = new PrometheusSerializer();

/** Retrieves current metrics in Prometheus exposition format. */
export async function getSerializedMetrics(): Promise<string> {
  if (!env.TELEMETRY_ENABLED || !prometheusExporter) {
    return "# Telemetry is disabled\n";
  }
  try {
    const collectionResult = await prometheusExporter.collect();
    return serializer.serialize(collectionResult.resourceMetrics);
  } catch {
    return "# Metrics not bound yet\n";
  }
}

// docs/specs/temporal-scheduler.md T9-T14 — scheduler-tick observability,
// incremented directly by apps/worker/src/schedule-tick-worker.ts.
export const scheduleTickTotal = meter.createCounter(
  "openwind_schedule_tick_total",
  {
    description:
      "Outcomes of the temporal scheduler tick (completed vs. failed)",
  },
);
export const scheduleExecutionTotal = meter.createCounter(
  "openwind_schedule_execution_total",
  {
    description:
      "Outcomes of individual schedule_rule fires (success/failed, with error_code)",
  },
);
export const scheduleCatchUpTotal = meter.createCounter(
  "openwind_schedule_catch_up_total",
  {
    description:
      "Catch-up fires executed vs. skipped on an overdue schedule_rule",
  },
);

// docs/temporal-scheduler-design.md §9.4 -- the duration SLO alerts read these.
// Milliseconds, with the unit in the name rather than a unit option, matching
// how this file registers http_request_duration_seconds. Execution duration is
// labelled by status only: tenant and rule ids stay out of labels so the
// series count stays bounded (each label value multiplies every bucket).
export const scheduleTickDurationMs = meter.createHistogram(
  "openwind_schedule_tick_duration_ms",
  {
    description: "Wall-clock time of one temporal scheduler tick, in ms",
    advice: { explicitBucketBoundaries: SCHEDULE_DURATION_BUCKETS_MS },
  },
);
export const scheduleExecutionDurationMs = meter.createHistogram(
  "openwind_schedule_execution_duration_ms",
  {
    description:
      "Time to fire one schedule_rule (create the ticket and record it), in ms",
    advice: { explicitBucketBoundaries: SCHEDULE_DURATION_BUCKETS_MS },
  },
);

// docs/specs/user-erasure-anonymization.md §B7 — a failed recordResolvedMention
// leaves a mention unrecorded, so a later erasure scrubs that comment
// incompletely. Deliberately unlabelled: tenantId stays in the log line.
export const mentionRecordFailureTotal = meter.createCounter(
  "openwind_mention_record_failure_total",
  {
    description:
      "Resolved mentions the mention-resolution worker failed to record on a comment",
  },
);

// docs/specs/retention-classes.md — rows removed by the retention sweep, so a
// sweep that deletes nothing (the pre-fix silent no-op) is visible on a dashboard.
export const retentionDeletedRowsTotal = meter.createCounter(
  "openwind_retention_deleted_rows_total",
  {
    description:
      "Rows deleted by the retention sweep, by table and retention class",
  },
);

export { meter };
