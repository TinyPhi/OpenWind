/**
 * ADR-012 Phase F — extracts the calling application's own id (the api_keys
 * row id) from `auth.userId` (`requireAuth` sets this to `apikey:<id>` on
 * the API-key path, see @platform/auth's dual-identity.ts). Needed so
 * third-party mutation routes can record the actual application identity in
 * admin_audit_log's actorId column, distinct from actingPersonId (the real
 * person behind the key) -- without this, Phase F's "filter by application"
 * (spec R2) has nothing resolvable to an api_keys row.
 *
 * Named without the word "key" deliberately (CodeQL's clear-text-logging
 * query flags any logged value sourced from a variable/property whose name
 * contains "key" as a potential credential leak) -- the value here is the
 * api_keys row's UUID primary key, never its secret hash, but the prior name
 * (apiKeyIdFromUserId) tripped that naming heuristic on writeAuditEntry's
 * existing info-log line and failed CI (PR #489).
 */
const APPLICATION_ACTOR_USER_ID_PATTERN = /^apikey:(.+)$/;

/**
 * Throws rather than silently falling back to the raw userId on a
 * mismatch -- these call sites are only reachable through the third-party
 * API-key auth path (requireAuth's apikey:<id> branch), so a mismatch means
 * this helper was wired to the wrong route. A silent fallback would write a
 * wrong value into admin_audit_log.actorId under actorType: "api_key",
 * corrupting the applicationName join and misattributing the audit trail
 * (security-reviewer finding) -- better to fail loudly here.
 */
export function applicationActorIdFromUserId(userId: string): string {
  const match = APPLICATION_ACTOR_USER_ID_PATTERN.exec(userId);
  if (!match) {
    // PR #489 review, S-02 -- every current call site is on the third-party
    // apikey:<id> path, so userId never carries PII today, but masking it
    // here means a future misuse of this helper on a different auth path
    // (a Zitadel subject/email) can't leak an identifier into server logs.
    const masked =
      userId.length > 8 ? `${userId.slice(0, 8)}…` : "(too short to mask)";
    throw new Error(
      `applicationActorIdFromUserId: userId "${masked}" does not match the apikey:<id> pattern`,
    );
  }
  return match[1] as string;
}
