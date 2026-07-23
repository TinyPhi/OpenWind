import pino from "pino";

const isDev = process.env["NODE_ENV"] !== "production";

export const logger = pino(
  {
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: ["password", "token", "secret", "authorization", "cookie"],
  },
  isDev
    ? // pino's own types alias pino.transport()'s return as `type ThreadStream = any`
      (pino.transport({
        target: "pino-pretty",
        options: { colorize: true },
      }) as pino.DestinationStream)
    : undefined,
);

export type Logger = typeof logger;
