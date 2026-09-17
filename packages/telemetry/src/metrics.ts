import { metrics } from "@opentelemetry/api";
import { Queue } from "./bullmq.js";
import { getRedis } from "@platform/redis";
import { env } from "@platform/config";
import { prometheusExporter } from "./instrumentation.js";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";

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
export { meter };
