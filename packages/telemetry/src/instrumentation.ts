import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import type { NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { PostgresInstrumentation } from "otel-instrumentation-postgres";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

const { ParentBasedSampler, TraceIdRatioBasedSampler } = tracing;

export let prometheusExporter: PrometheusExporter | undefined;

if (env.TELEMETRY_ENABLED) {
  logger.info(
    {
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      serviceName: env.OTEL_SERVICE_NAME,
      sampleRatio: env.OTEL_TRACE_SAMPLE_RATIO,
    },
    "Initializing OpenTelemetry SDK",
  );

  prometheusExporter = new PrometheusExporter({
    preventServerStart: true,
  });

  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(env.OTEL_TRACE_SAMPLE_RATIO),
  });

  const sdkOptions: Partial<NodeSDKConfiguration> = {
    serviceName: env.OTEL_SERVICE_NAME ?? "openwind",
    metricReader: prometheusExporter,
    sampler,
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
      new PostgresInstrumentation({
        // collectQueryParameters is disabled by default to prevent leaking PII
        // (email addresses, token hashes, personal info) into trace databases.
        // If ever enabled, trace backend filtering/redaction processors must be in place.
        collectQueryParameters: false,
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
