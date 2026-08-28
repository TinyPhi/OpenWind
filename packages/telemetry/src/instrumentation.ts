import { NodeSDK } from "@opentelemetry/sdk-node";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { PostgresInstrumentation } from "otel-instrumentation-postgres";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import * as bullmq from "bullmq";
import { BullMQOtel } from "bullmq-otel";

export const prometheusExporter = new PrometheusExporter({
  preventServerStart: true,
});

if (env.TELEMETRY_ENABLED) {
  logger.info(
    {
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: env.OTEL_SERVICE_NAME,
    },
    "Initializing OpenTelemetry SDK",
  );

  const telemetry = new BullMQOtel(env.OTEL_SERVICE_NAME ?? "openwind");

  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-condition */
  // Patch bullmq.Queue
  const OriginalQueue = bullmq.Queue;
  const PatchedQueue = function (this: any, name: string, opts?: any): any {
    const options = { ...opts, telemetry };
    return Reflect.construct(
      OriginalQueue,
      [name, options],
      new.target ?? PatchedQueue,
    );
  };
  PatchedQueue.prototype = OriginalQueue.prototype;
  Object.setPrototypeOf(PatchedQueue, OriginalQueue);
  (bullmq as any).Queue = PatchedQueue;

  // Patch bullmq.Worker
  const OriginalWorker = bullmq.Worker;
  const PatchedWorker = function (
    this: any,
    name: string,
    processor?: any,
    opts?: any,
  ): any {
    const options = { ...opts, telemetry };
    return Reflect.construct(
      OriginalWorker,
      [name, processor, options],
      new.target ?? PatchedWorker,
    );
  };
  PatchedWorker.prototype = OriginalWorker.prototype;
  Object.setPrototypeOf(PatchedWorker, OriginalWorker);
  (bullmq as any).Worker = PatchedWorker;
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

  const sdkOptions: Partial<NodeSDKConfiguration> = {
    serviceName: env.OTEL_SERVICE_NAME ?? "openwind",
    metricReader: prometheusExporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
      new PostgresInstrumentation({
        collectQueryParameters: true,
      }),
    ],
  };

  if (env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    sdkOptions.traceExporter = new OTLPTraceExporter({
      url: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    });
  }

  const sdk = new NodeSDK(sdkOptions);

  try {
    sdk.start();
    logger.info("OpenTelemetry SDK started successfully");
  } catch (error) {
    logger.error({ err: error }, "Error starting OpenTelemetry SDK");
  }
}
