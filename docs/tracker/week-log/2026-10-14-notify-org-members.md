# 2026-10-14 — users who never signed in are notifiable; emails use the latest address

**Session type:** Bugs found testing sandbox notifications
**Branch:** `fix/notify-org-members`

- **Symptom 1: an @mention notified nobody.** The comment endpoint only notifies (or grants
  access to) mentioned users who are tenant members, and membership meant a `tenant_users`
  row, which is only written when someone first signs in. A user who exists in the tenant's
  Zitadel org but never signed in was silently dropped: the mention was saved on the comment,
  but there was no `comment.mentioned` event, no in-app notification and no email. This
  affected every tenant, not just sandboxes, where it hit hardest because none of the seeded
  accounts had signed in. Assignment notifications weren't affected, because they don't use
  that check.
- **Fix.** `ensureTenantMembers` (apps/api/src/lib/ensure-user-refs.ts) counts someone as a
  member if they're in `tenant_users` **or** in the tenant's own Zitadel org (`listOrgUsers(orgId)`).
  Confirmed org members are upserted into `tenant_users` on the way. It is the pattern
  `ensureUserRefsKnown` and on-call already used, now shared.
  - Used by comment @mentions and grant-access.
  - An id outside the tenant's org is still rejected; without an orgId only existing rows count.
- **Sandboxes.** Provisioning now registers every seeded account in `tenant_users` (best
  effort; the Zitadel-org fallback covers a failure).
- **Symptom 2: email to an old address.** The outbound email step read recipients through
  `getUserById`'s 5-minute in-memory cache, so a user whose email had just changed in Zitadel
  could still be mailed at the old address. It now calls `getUserById(userId, { fresh: true })`,
  which skips the cache read (refreshing it) and falls back to the cached value if Zitadel is
  unreachable. Each send logs its recipients with masked addresses (`t***@gmail.com`), so
  "where did this email go?" can be answered from our logs.
- **Tests.**
  - `ensureTenantMembers`: existing members, org members added, outsiders never added, no
    orgId, Zitadel down.
  - Comment mentions: a never-signed-in org member is notified/granted; an outsider is still
    dropped.
  - Grant-access: checks the target, with the orgId.
  - `getUserById`: fresh vs cached, and the fallback.
  - Outbound: fresh lookup, payload address, masked log, `maskEmail`.
  - Provisioning: every seeded account is registered; a registration failure isn't fatal.
