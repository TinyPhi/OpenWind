import { listOrgUsers } from "./zitadel-management.js";

export type OrgMemberResolution = { ok: true; userId: string } | { ok: false };

/**
 * Resolves a caller-supplied identifier to the canonical Zitadel user id
 * every other part of the platform expects wherever a user reference is
 * stored (e.g. entity_instances.assigned_to -- admin-ui's AssignDropdown
 * matches strictly against a user's numeric `userId`, never their
 * username).
 *
 * Accepts a raw userId (already-correct callers keep working unchanged), a
 * username/login name (`loginName` on the org-users list), or -- when
 * `matchEmail` is set -- an email address too (the third-party comment
 * `mentions` field has always documented email as an accepted identifier
 * shape). Humans naturally remember usernames/emails, not opaque numeric
 * ids.
 *
 * Ported from the AuthNexus-paired fork's identical fix (2026-09-07/08):
 * `assignedTo` was previously stored verbatim with zero validation there --
 * a username silently landed in `assigned_to`, matched no real user in the
 * UI's own lookup, and the ticket simply looked "unassigned" with no error
 * surfaced anywhere (found via manual testing against a real client org's
 * production instance). Reused for comment `mentions` validation for the
 * same reason: an unresolvable @mention previously succeeded silently
 * (async, never reported back, by deliberate original design -- see
 * comments.ts's own history/ADR-012 spec R5/R6 -- specifically to prevent
 * using the mentions list as an org-member enumeration probe). That
 * protection was deliberately relaxed by a conscious decision on the
 * AuthNexus fork, carried over here: the caller now gets a plain "not
 * found" error with no user list or suggestions attached, so the failure
 * signal itself doesn't leak anything beyond "this one identifier didn't
 * match."
 *
 * Unlike the AuthNexus fork's version, this tree's `listOrgUsers` takes no
 * bearer token -- Zitadel management-API calls authenticate via this
 * platform's own service account token (see zitadel-management.ts), not a
 * per-request acting-person token -- so there is no token parameter here.
 *
 * Returns { ok: false } for anything that resolves to none of the above --
 * callers should reject with 422 rather than silently persisting/using an
 * unresolvable value.
 */
export async function resolveOrgMemberUserId(
  orgId: string | undefined,
  value: string,
  opts?: { matchEmail?: boolean },
): Promise<OrgMemberResolution> {
  if (!orgId) return { ok: false };
  const users = await listOrgUsers(orgId);
  const match = users.find(
    (u) =>
      u.userId === value ||
      u.loginName === value ||
      (opts?.matchEmail && u.email === value),
  );
  return match ? { ok: true, userId: match.userId } : { ok: false };
}
