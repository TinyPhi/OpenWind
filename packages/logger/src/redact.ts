/**
 * Single source of PII-scrubbing rules, shared by the pino logger and Sentry beforeSend
 * (ADR-015 Decision #2). Every regex is length-bounded so scrubbing is linear on hostile input.
 */

export const REDACTED = "[REDACTED]";

export const REDACT_KEYS: readonly string[] = [
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
  "client_secret",
  "auth_token",
  "x-auth-token",
  "cookies",
  "set-cookie",
  "session",
  "session_id",
  "csrf",
  "csrf_token",
];

// Compared case-, dash- and underscore-insensitively so accessToken, access_token and
// Access-Token are one key.
const normalizeKey = (key: string): string =>
  key.toLowerCase().replace(/[-_]/g, "");

const REDACT_KEY_SET: ReadonlySet<string> = new Set(
  REDACT_KEYS.map(normalizeKey),
);

export function isRedactedKey(key: string): boolean {
  return REDACT_KEY_SET.has(normalizeKey(key));
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** pino `redact` paths for REDACT_KEYS at the top level and one level deep. */
export const PINO_REDACT_PATHS: readonly string[] = REDACT_KEYS.flatMap(
  (key) =>
    IDENT.test(key) ? [key, `*.${key}`] : [`["${key}"]`, `*["${key}"]`],
);

/** Longest string scrubbed in full; the remainder is dropped (fail closed, bounds regex work). */
export const MAX_SCRUB_LENGTH = 16_384;
export const MAX_SCRUB_DEPTH = 64;
const TRUNCATED_SUFFIX = "...[truncated]";

const SECRET_KEYWORDS =
  "(?:set-cookie|cookie|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret|private[_-]?key)";

interface TextRule {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

export const TEXT_RULES: readonly TextRule[] = [
  {
    name: "bearer",
    pattern: /\b(Bearer\s{1,8})[A-Za-z0-9._~+/=-]{1,2048}/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    // Requires a digit or base64 symbol so prose such as "Basic information" is left alone.
    name: "basic",
    pattern:
      /\b(Basic\s{1,8})(?=[A-Za-z0-9+/]{0,2048}[0-9+/=])[A-Za-z0-9+/]{8,2048}={0,2}/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    name: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{5,2048}\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{0,2048}/g,
    replacement: REDACTED,
  },
  {
    name: "email",
    pattern:
      /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}/g,
    replacement: REDACTED,
  },
  {
    name: "key-value-secret",
    pattern: new RegExp(
      `(${SECRET_KEYWORDS}["']?\\s{0,3}[=:]\\s{0,3})("(?:[^"\\\\]|\\\\.){0,1024}"|'(?:[^'\\\\]|\\\\.){0,1024}'|(?:(?:Bearer|Basic|Token|Digest|ApiKey|Bot|Negotiate)\\s{1,8})?[^\\s,;&"']{1,1024})`,
      "gi",
    ),
    replacement: `$1${REDACTED}`,
  },
];

/** Redacts emails, bearer/JWT tokens and key=value secrets inside free text. */
export function scrubString(input: string): string {
  let text = input;
  let truncated = false;
  if (text.length > MAX_SCRUB_LENGTH) {
    text = text.slice(0, MAX_SCRUB_LENGTH);
    truncated = true;
  }
  for (const rule of TEXT_RULES) {
    text = text.replace(rule.pattern, rule.replacement);
  }
  return truncated ? text + TRUNCATED_SUFFIX : text;
}

/**
 * Recursively scrubs a payload in place: redacts values under sensitive keys and runs
 * scrubString over every string value. Circular references are tolerated.
 */
export function scrubPIIInPlace(
  val: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): void {
  if (val === null || typeof val !== "object" || seen.has(val)) {
    return;
  }
  seen.add(val);

  if (Array.isArray(val)) {
    const arr = val as unknown[]; // Array.isArray narrows to any[], not unknown[] — widen element type explicitly
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (typeof v === "string") {
        arr[i] = scrubString(v);
      } else if (
        v !== null &&
        typeof v === "object" &&
        depth >= MAX_SCRUB_DEPTH
      ) {
        arr[i] = REDACTED;
      } else {
        scrubPIIInPlace(v, seen, depth + 1);
      }
    }
    return;
  }

  const obj = val as Record<string, unknown>; // typeof narrows to object but not the string-indexed record shape
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (isRedactedKey(key)) {
      obj[key] = REDACTED;
    } else if (typeof value === "string") {
      obj[key] = scrubString(value);
    } else if (
      value !== null &&
      typeof value === "object" &&
      depth >= MAX_SCRUB_DEPTH
    ) {
      obj[key] = REDACTED; // fail closed instead of recursing without bound
    } else {
      scrubPIIInPlace(value, seen, depth + 1);
    }
  }
}
