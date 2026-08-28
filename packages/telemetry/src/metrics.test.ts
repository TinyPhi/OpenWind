/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";

// Mutable mock config object
const mockEnv = {
  TELEMETRY_ENABLED: true,
  REDIS_URL: "redis://localhost:6379",
};

// Mock config BEFORE any imports
vi.mock("@platform/config", () => ({
  env: mockEnv,
}));

// Mock redis client
vi.mock("@platform/redis", () => ({
  getRedis: () => ({
    on: vi.fn(),
    quit: vi.fn(),
  }),
}));

// Mock BullMQ Queue and Worker classes so it doesn't hit Redis during tests
vi.mock("bullmq", () => {
  return {
    Queue: class MockQueue {
      constructor(
        public name: string,
        public opts?: any,
      ) {}
      async getJobCounts() {
        return {
          active: 1,
          waiting: 2,
          delayed: 3,
          failed: 4,
        };
      }
    },
    Worker: class MockWorker {
      constructor(
        public name: string,
        public processor: any,
        public opts?: any,
      ) {}
    },
  };
});

// Import instrumentation first so SDK starts and binds the reader
await import("./instrumentation.js");
const { getSerializedMetrics, httpRequestsTotal, httpRequestDuration } =
  await import("./metrics.js");

describe("Metrics serialization", () => {
  it("generates Prometheus format string containing metric metadata", async () => {
    // Ensure telemetry is enabled for this test
    mockEnv.TELEMETRY_ENABLED = true;

    // Record values so the metrics are materialized in the export
    httpRequestsTotal.add(1, {
      method: "GET",
      route: "/test",
      status: "200",
      tenant_id: "test",
    });
    httpRequestDuration.record(0.1, {
      method: "GET",
      route: "/test",
      status: "200",
      tenant_id: "test",
    });

    const metrics = await getSerializedMetrics();
    expect(metrics).toContain("# HELP http_requests_total");
    expect(metrics).toContain("# TYPE http_requests_total");
    expect(metrics).toContain("# HELP http_request_duration_seconds");
    expect(metrics).toContain("# TYPE http_request_duration_seconds");
    expect(metrics).toContain("# HELP bullmq_queue_depth");
    expect(metrics).toContain("# TYPE bullmq_queue_depth");
  });

  it("handles disabled telemetry gracefully", async () => {
    // Disable telemetry
    mockEnv.TELEMETRY_ENABLED = false;

    const metrics = await getSerializedMetrics();
    expect(metrics).toBe("# Telemetry is disabled\n");
  });
});

describe("BullMQ dynamic monkeypatching", () => {
  it("patches bullmq.Queue constructor to automatically inject telemetry option", async () => {
    const bullmq = await import("bullmq");
    const q = new bullmq.Queue("test-patched-queue", { connection: {} } as any);
    expect(q.opts.telemetry).toBeDefined();
  });

  it("patches bullmq.Worker constructor to automatically inject telemetry option", async () => {
    const bullmq = await import("bullmq");
    const w = new bullmq.Worker("test-patched-worker", async () => {}, {
      connection: {},
    } as any);
    expect(w.opts.telemetry).toBeDefined();
  });
});
