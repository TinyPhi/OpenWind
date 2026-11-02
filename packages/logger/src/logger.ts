import pino from "pino";
import { PINO_REDACT_PATHS, REDACTED, scrubString } from "./redact.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const isDev = process.env["NODE_ENV"] !== "production";

export const loggerOptions: pino.LoggerOptions = {
  level: process.env["LOG_LEVEL"] ?? "info",
  serializers: {
    err(err: unknown) {
      if (!(err instanceof Error)) {
        return err;
      }
      const serialized = pino.stdSerializers.err(err);
      for (const field of ["message", "stack"] as const) {
        const v: unknown = serialized[field];
        if (typeof v === "string") {
          serialized[field] = scrubString(v);
        }
      }
      return serialized;
    },
  },
  redact: { paths: [...PINO_REDACT_PATHS], censor: REDACTED },
  hooks: {
    // Scrub free-text PII in the message and top-level string fields with the same rules
    // Sentry beforeSend uses (shared redact.ts).
    logMethod(args, method) {
      const scrubbed = args.map((arg) => {
        if (typeof arg === "string") {
          return scrubString(arg);
        }
        if (isPlainObject(arg)) {
          const copy: Record<string, unknown> = { ...arg };
          for (const key of Object.keys(copy)) {
            const v = copy[key];
            if (typeof v === "string") {
              copy[key] = scrubString(v);
            }
          }
          return copy;
        }
        return arg;
      });
      return method.apply(this, scrubbed as Parameters<typeof method>); // map preserves arity/order; pino's overloaded tuple type can't be inferred
    },
  },
};

export const logger = pino(
  loggerOptions,
  isDev
    ? // pino's own types alias pino.transport()'s return as `type ThreadStream = any`
      (pino.transport({
        target: "pino-pretty",
        options: { colorize: true },
      }) as pino.DestinationStream)
    : undefined,
);

export type Logger = typeof logger;
