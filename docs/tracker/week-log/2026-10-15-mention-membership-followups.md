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

## Security review follow-up

- `ensureUserRefsKnown` selects the `user_ref` field names with an explicit tenant filter (`tenant_id IS NULL OR tenant_id = tenantId`, since global fields have a null tenant) as well as RLS, matching the rule that every query filters on tenant_id. Before, only RLS kept another tenant's fields out.
- Accepted and noted by the review, not changed: the tenant_users upsert commits before the entity transaction (only genuine members of the caller's own org get rows), and failed Zitadel lookups are not negatively cached (bounded by the per-tenant rate limit).
