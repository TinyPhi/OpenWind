import * as Sentry from "@sentry/node";
import { env } from "@platform/config";
import { logger } from "@platform/logger";

const REDACT_KEYS = new Set([
  "password",
  "token",
  "secret",
  "authorization",
  "cookie",
  "email",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "phone",
  "phone_number",
  "x-api-key",
  "private_key",
]);

let initialized = false;

/**
 * Recursively scrubs PII from a Sentry event payload in-place.
 * Prevents circular references via WeakSet.
 */
export function scrubPIIInPlace(val: unknown, seen = new WeakSet()): void {
  if (val === null || val === undefined) {
    return;
  }

  if (typeof val !== "object") {
    return;
  }

  if (seen.has(val)) {
    return;
  }
  seen.add(val);

  if (Array.isArray(val)) {
    const arr = val as unknown[];
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v && typeof v === "object") {
        scrubPIIInPlace(v, seen);
      }
    }
    return;
  }

  const obj = val as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const lowerKey = key.toLowerCase();
    if (REDACT_KEYS.has(lowerKey)) {
      obj[key] = "[REDACTED]";
    } else if (value && typeof value === "object") {
      scrubPIIInPlace(value, seen);
    }
  }
}

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
      beforeSend(event) {
        try {
          scrubPIIInPlace(event);
          return event;
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
