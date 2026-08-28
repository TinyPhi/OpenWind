// ADR-008 Decision #6 / ADR-010: api_keys.scopes is re-shaping from role-strings
// ("admin") to action-strings ("entity:<entityType>:<verb>", e.g.
// "entity:ticket:read"). This module tells the two apart structurally rather
// than hardcoding the verb set — OQ-5 (the exact verb list) is still open
// pending joint sign-off with whoever scopes ADR-010's Tier-1 rollout, but the
// "entity:<entityType>:<verb>" shape itself is already confirmed
// (.claude/context/phase-3-primer.md, Stage 2).
//
// This intentionally recognises the shape, not any specific verb — adding a
// new verb later must not require touching this file.
const ACTION_SCOPE_PATTERN = /^entity:[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;

export type ScopesFormat = "role" | "action";

/**
 * Classifies a key's full scopes array as one format or the other. A key's
 * scopes are never a mix of both — that would mean a single ceiling check
 * (scope-ceiling.ts) is comparing role-levels against action-strings, which
 * has no defined meaning. Empty arrays default to "role", matching
 * api_keys.scopes_format's column default for keys minted with no scopes.
 */
export function detectScopesFormat(scopes: readonly string[]): ScopesFormat {
  if (scopes.length === 0) {
    return "role";
  }
  const actionCount = scopes.filter((s) => ACTION_SCOPE_PATTERN.test(s)).length;
  if (actionCount === scopes.length) {
    return "action";
  }
  if (actionCount === 0) {
    return "role";
  }
  throw new Error(
    `Cannot determine scopes_format: scopes mix action-shaped and role-shaped strings (${scopes.join(", ")})`,
  );
}

// ADR-012 Phase A (Third-Party API), spec R8: the concrete entity:ticket:<verb>
// vocabulary a third-party API key's scopes are validated against at mint
// time. This is the first real consumer of the "action" format the shape
// above only recognises structurally — OQ-5's verb list is now pinned to
// exactly these six, matching the Key Management screen's Read-only/
// Read-write presets ([entity:ticket:read] / all six).
export const TICKET_ACTION_VERBS = [
  "create",
  "read",
  "comment",
  "transition",
  "subticket",
  "attach",
] as const;

export type TicketActionVerb = (typeof TICKET_ACTION_VERBS)[number];

const KNOWN_TICKET_ACTION_SCOPES = new Set<string>(
  TICKET_ACTION_VERBS.map((verb) => `entity:ticket:${verb}`),
);

/**
 * Returns every scope string that is action-shaped but not in the known
 * entity:ticket:<verb> vocabulary — empty means every scope is recognised.
 * Only meaningful for an "action"-format scopes array; role-format scopes
 * are validated by the existing role hierarchy (scope-ceiling.ts), not this.
 */
export function unknownTicketActionScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => !KNOWN_TICKET_ACTION_SCOPES.has(s));
}
