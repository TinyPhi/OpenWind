# 2026-10-28 — The login page shows no brand without a match (R13, revised)

**Session type:** UI change (docs/specs/multi-org-sandbox.md R13, Phase 7, T49–T51)
**Branch:** `feat/login-org-branding` (local, on top of PR #1077; the PR opens after #1077 merges)

- **Why.** With an edited login key the page fell back to the generic OpenWind login, as the spec then
  said. The owner wants no brand at all in that case: no org name and no product name either.
- **Behaviour.** A valid login key still fills in the top-left logo (or initials tile) and name, the card
  breadcrumb ("<name> / Sign in") and the browser tab title. Without a match the top-left block is not
  rendered (no OpenWind icon or wordmark), the breadcrumb reads just "Sign in", and the tab title is
  "Sign in". "Without a match" is plain `/login` (still no lookup), every miss (unknown or edited key,
  real tenant, suspended or deleted sandbox, rate limit, server or network error, malformed answer, a
  logo that is not a raster data URL, a key-shaped check failing client side) and the moment while a
  lookup is running, so a sandbox visitor never sees a name flash first. Sign-in is unchanged and never
  waits on the lookup.
- **Decisions.** Both blank (plain `/login` too), chosen over keeping OpenWind on plain `/login`, so a
  visitor cannot tell "no link" from "wrong link". The tab title is "Sign in", since a title cannot be
  empty and the page's built-in one says OpenWind. The unused `login.brandName` string was removed.
- **Not changed.** The app header after sign-in (OpenWind for normal tenants, the org brand for
  sandboxes), the lookup route, the database, the platform-admin pages and the "Contact us" mail draft.
- **Tests.** The login page now asserts, for plain `/login`, a pending lookup, six kinds of miss and five
  values that are not keys, that there is no top-left block, no `img.logo-icon`, the breadcrumb is
  "Sign in", the title is "Sign in", and the word OpenWind appears in none of the brand areas; and for a
  hit the logo or initials, the name, the breadcrumb, the title and its restoration on leaving.
