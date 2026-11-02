export { logger, loggerOptions } from "./logger.js";
export type { Logger } from "./logger.js";
export {
  MAX_SCRUB_LENGTH,
  PINO_REDACT_PATHS,
  REDACTED,
  REDACT_KEYS,
  TEXT_RULES,
  isRedactedKey,
  scrubPIIInPlace,
  scrubString,
} from "./redact.js";
