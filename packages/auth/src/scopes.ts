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
