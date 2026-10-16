# 2026-10-15 — mention and membership follow-ups

**Session type:** Review follow-ups
**Branch:** `fix/PLAT-952-mention-membership-followups`
**Issue:** #952 (from the review of #942)

- **Done.** `listOrgUsers` pages (500 per page, 20 pages max); `resolveTenantMembers` reads membership,
  calls Zitadel with no transaction open, then records new members in a second short context (used by
  add-comment and grant-access); `mentions` bounded at 50; a failed org lookup is evicted from the cache (it used to stay cached as empty); the outbound notification worker looks recipients
  up five at a time and `getUserById` treats a 429 like an outage (cached profile); CHANGELOG entry.
- **Deferred.** `ensureUserRefsKnown` (create and update) still calls the cached `listOrgUsers` inside the
  entity transaction: its candidate ids come from reads in that same transaction, so moving the call out
  needs a larger restructure of those two routes. Tracked on #952.
- **Verified.** Unit tests for pagination, 429 fallback, the read-then-Zitadel-then-write order, the mention
  bound and the lookup concurrency; mutation checks confirmed the pagination, 429 and concurrency tests bite.
