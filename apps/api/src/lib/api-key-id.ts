/**
 * ADR-012 Phase F — extracts the API key's own id from `auth.userId`
 * (`requireAuth` sets this to `apikey:<id>` on the API-key path, see
 * @platform/auth's dual-identity.ts). Needed so third-party mutation routes
 * can record the actual application identity in admin_audit_log's actorId
 * column, distinct from actingPersonId (the real person behind the key) --
 * without this, Phase F's "filter by application" (spec R2) has nothing
 * resolvable to an api_keys row.
 */
const API_KEY_USER_ID_PATTERN = /^apikey:(.+)$/;

/**
 * Throws rather than silently falling back to the raw userId on a
 * mismatch -- these call sites are only reachable through the third-party
 * API-key auth path (requireAuth's apikey:<id> branch), so a mismatch means
 * this helper was wired to the wrong route. A silent fallback would write a
 * non-key value into admin_audit_log.actorId under actorType: "api_key",
 * corrupting the applicationName join and misattributing the audit trail
 * (security-reviewer finding) -- better to fail loudly here.
 */
export function apiKeyIdFromUserId(userId: string): string {
  const match = API_KEY_USER_ID_PATTERN.exec(userId);
  if (!match) {
    throw new Error(
      `apiKeyIdFromUserId: userId "${userId}" does not match the apikey:<id> pattern`,
    );
  }
  return match[1] as string;
}
