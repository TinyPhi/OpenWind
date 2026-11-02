import * as Sentry from "@sentry/node";
import { env } from "@platform/config";
import { logger, scrubPIIInPlace } from "@platform/logger";

let initialized = false;

interface StackFrameLike {
  pre_context?: unknown;
  context_line?: unknown;
  post_context?: unknown;
}

interface StacktraceHolder {
  stacktrace?: { frames?: StackFrameLike[] };
}

function stripSourceContext(holders: StacktraceHolder[] | undefined): void {
  for (const holder of holders ?? []) {
    for (const frame of holder.stacktrace?.frames ?? []) {
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
}

/**
 * Scrubs a Sentry event in place with the rules shared with @platform/logger (key redaction plus
 * free-text patterns over every string value: message, exception values, breadcrumbs, extra,
 * contexts, tags). Then drops fields the shared rules cannot cover:
 * - user.ip_address: client IP is PII; dropped rather than hashed, since a hash of an IPv4 is
 *   trivially reversible.
 * - server_name: the SDK's hostname, often a developer or container identifier.
 * - request.data, request.query_string and the URL query/fragment: free-form user input.
 * - source context lines (pre_context, context_line, post_context): hardcoded literals in code
 *   are not pattern-detectable. Stack frames keep filename, line and function.
 */
export function scrubSentryEvent<T extends object>(event: T): T {
  scrubPIIInPlace(event);
  const e = event as {
    user?: Record<string, unknown>;
    server_name?: unknown;
    request?: Record<string, unknown>;
    exception?: { values?: StacktraceHolder[] };
    threads?: { values?: StacktraceHolder[] };
  }; // Sentry Event type not imported; only touching known optional fields
  if (e.user && typeof e.user === "object") {
    delete e.user["ip_address"];
  }
  delete e.server_name;
  if (e.request && typeof e.request === "object") {
    delete e.request["data"];
    delete e.request["query_string"];
    if (typeof e.request["url"] === "string") {
      e.request["url"] = e.request["url"].replace(/[?#].*$/s, "");
    }
  }
  stripSourceContext(e.exception?.values);
  stripSourceContext(e.threads?.values);
  return event;
}

export { scrubPIIInPlace };

/**
 * Initializes Sentry-compatible error tracking if enabled.
 */
export function startErrorTracking(): void {
  if (initialized) {
    logger.warn("Error tracking is already initialized.");
    return;
  }

  const provider = env.ERROR_TRACKING_PROVIDER;
  if (provider === "none") {
    logger.info("Error tracking is disabled (ERROR_TRACKING_PROVIDER=none)");
    return;
  }

  if (!env.SENTRY_DSN) {
    logger.warn(
      `Error tracking provider is set to '${provider}', but SENTRY_DSN is missing.`,
    );
    return;
  }

  let host: string | undefined;
  try {
    host = new URL(env.SENTRY_DSN).hostname;
  } catch {
    // Ignore invalid DSN parsing
  }

  logger.info(
    { provider, host },
    "Initializing pluggable error tracking via Sentry SDK",
  );

  try {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      // Explicit privacy posture (ADR-015): no default PII (IP, cookies, request bodies, user)
      // and no Sentry tracing/profiling: tracesSampleRate/tracesSampler/profilesSampleRate must
      // stay unset (even 0 would enable span handling); spans belong to the OTel NodeSDK.
      sendDefaultPii: false,
      // Unset, Sentry adds sentry-trace/baggage (incl. the DSN public key) to outbound HTTP to any
      // host, i.e. connectors, webhooks and partners; an empty list propagates to none.
      tracePropagationTargets: [],
      beforeSend(event) {
        try {
          return scrubSentryEvent(event);
        } catch (error) {
          logger.error(
            { err: error },
            "Sentry beforeSend PII scrubbing failed - dropping event to prevent data leak",
          );
          return null;
        }
      },
    });
    initialized = true;
  } catch (error) {
    logger.error({ err: error }, "Failed to initialize error tracking SDK");
  }
}

/**
 * Manually captures an exception to Sentry if initialized.
 */
export function captureException(error: unknown): void {
  if (env.ERROR_TRACKING_PROVIDER !== "none" && initialized) {
    Sentry.captureException(error);
  }
}
