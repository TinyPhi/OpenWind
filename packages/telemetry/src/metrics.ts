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
