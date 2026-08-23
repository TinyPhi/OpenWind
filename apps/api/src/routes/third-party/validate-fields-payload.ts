// ADR-012 Phase B, spec R11/R13 — an ingress-level guard ahead of
// entity-engine's own validation. Neither check exists anywhere else in the
// codebase today (gap #10 from the original security gap analysis): the
// human/UI create route's `fields` is a bare `z.record(z.unknown())` with no
// size/depth/char guard, because a browser session's own JSON.parse and the
// UI form itself already bound what's practically submittable — a
// third-party API has no such implicit bound.

const MAX_FIELDS_JSON_BYTES = 100_000;
const MAX_FIELDS_DEPTH = 8;

// C0 control characters and DEL, excluding tab/LF/CR (0x09/0x0A/0x0D) which
// are legitimate in free-text field values. Includes the null byte (0x00).
// eslint-disable-next-line no-control-regex -- intentional: this IS the control-character check.
const FORBIDDEN_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export type FieldsPayloadValidation =
  | { ok: true }
  | { ok: false; reason: string };

function walk(value: unknown, depth: number): string | null {
  if (depth > MAX_FIELDS_DEPTH) {
    return `fields payload exceeds maximum nesting depth of ${MAX_FIELDS_DEPTH}`;
  }
  if (typeof value === "string") {
    if (FORBIDDEN_CHAR_PATTERN.test(value)) {
      return "fields payload contains a null byte or control character";
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const err = walk(item, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) {
      const err = walk(v, depth + 1);
      if (err) return err;
    }
    return null;
  }
  return null;
}

/**
 * Validates a ticket-creation `fields` payload before it reaches
 * entity-engine's own field-level validation. Two independent checks:
 * overall serialized size (R13) and per-string forbidden characters (R11).
 * Depth is checked as part of the same walk since both need the same
 * recursive traversal.
 */
export function validateFieldsPayload(
  fields: Record<string, unknown>,
): FieldsPayloadValidation {
  const serialized = JSON.stringify(fields);
  if (serialized.length > MAX_FIELDS_JSON_BYTES) {
    return {
      ok: false,
      reason: `fields payload exceeds maximum size of ${MAX_FIELDS_JSON_BYTES} bytes`,
    };
  }

  const err = walk(fields, 0);
  if (err) {
    return { ok: false, reason: err };
  }

  return { ok: true };
}
