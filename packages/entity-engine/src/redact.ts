/**
 * redact.ts
 *
 * Pure function for redacting PII/financial field values before they are
 * written to a secondary/derived store with broader readership or retention
 * than the entity record itself (outbox_events, workflow_events.metadata,
 * admin_audit_log). Defined locally rather than imported from
 * workflow-engine's equivalent (packages/workflow-engine/src/redact.ts)
 * because entity-engine may only depend on db per CLAUDE.md's dependency
 * rule — workflow-engine depends on entity-engine, not the reverse.
 *
 * Contract:
 *  - Field VALUES for `pii` and `financial` sensitivity levels are replaced
 *    with the string "[REDACTED]"
 *  - Field NAMES (keys) are always preserved
 *  - `public` and `internal` field values pass through unmodified
 *  - Keys that do not correspond to any known field pass through unmodified
 *  - Only top-level keys are checked — nested objects are not traversed
 *  - Pure: never mutates the input, always returns a new object
 */

import type { FieldSensitivity } from "./types.js";

export function redactFields(
  fields: Record<string, unknown>,
  sensitivityMap: Map<string, FieldSensitivity>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    const sensitivity = sensitivityMap.get(key);
    if (sensitivity === "pii" || sensitivity === "financial") {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

export function buildSensitivityMap(
  fields: ReadonlyArray<{ name: string; sensitivity: FieldSensitivity }>,
): Map<string, FieldSensitivity> {
  const map = new Map<string, FieldSensitivity>();
  for (const field of fields) {
    if (field.sensitivity === "pii" || field.sensitivity === "financial") {
      map.set(field.name, field.sensitivity);
    }
  }
  return map;
}
