# 2026-10-26 — Login page shows a sandbox's brand on its own login link (R13)

**Session type:** feature (docs/specs/multi-org-sandbox.md R13, T33–T40)
**Branch:** `feat/login-org-branding`, local, on top of `feat/sandbox-branding` (PR #1077). The PR is
opened only after #1077 merges, replaying these commits with `git rebase --onto upstream/main
<#1077 tip>`, so it needs nothing from #1077's squash commit.

- **What.** `/login?org=<slug>` shows that sandbox's logo (or the initials tile of its name) and name
  at the top left of the login page, in place of the OpenWind icon and wordmark. Plain `/login`
  is generic and makes no request. Every miss gives the generic page and cannot be told apart from
  another: an unknown or malformed slug, a real tenant, a suspended or deleted sandbox, a
  rate-limited lookup, a timeout, a network failure. The lookup never blocks signing in.
- **API.** `GET /public/org-branding/:slug`, unauthenticated. Returns only `{ name, logo }` for an
  `active` `is_sandbox` tenant; every other case is one identical `404` (`no-store`), and a
  malformed slug is refused before the database is read. A hit is `public, max-age=60`. It has its
  own per-IP limiter, bucket `rl:public-branding:<ip>`, apart from the `/auth` class (10 per minute,
  shared with sign-in), set by `RATE_LIMIT_PUBLIC_BRANDING_PER_MIN` (default 30). It lets requests
  through if Redis is down, as the other limiters do.
- **Link for the platform admin.** Migration `0161_platform_admin_slug_grant` gives
  `platform_admin_role` `SELECT (slug)` and nothing wider. `slug` is on the sandbox view, the row
  menu has "Copy login link", the detail panel shows it, and the creation reveal, handover CSV and
  clipboard text carry it (the handover response now has the slug).
- **UI.** The header brand block moved out of `layout.tsx` into a shared `HeaderBrand`, so the app
  header and the login page cannot drift apart. `useLoginOrgBranding` uses a plain `fetch`
  (the page has no session) with a 4 s timeout and holds the brand's space invisibly while loading.
- **Decisions.** Slug is the existing `tenants.slug` (`<name>-<4 digits>`), no token column. The
  config variable is `RATE_LIMIT_PUBLIC_BRANDING_PER_MIN`, after its siblings (the spec first said
  `PUBLIC_BRANDING_RATE_LIMIT_PER_MIN`). The route lives under `/public`, not `/auth`, so it neither
  consumes nor hides in the sign-in bucket.
- **Not in this change.** Branding Zitadel's own sign-in screen (the visitor still sees Zitadel's after
  pressing sign-in; per-org Zitadel branding is a separate follow-up), a vanity domain, a slug token
  that cannot be guessed.
- **Tests.** Unit: the route, the limiter helper, the handover slug, the view, the login hook, the
  login page (8 miss and failure cases), the link helper, the CSV and clipboard column, the row
  menu, the detail panel and the creation reveal. Isolation (real Postgres, throwaway container):
  only an active sandbox is answered; a real tenant and suspended, deleted and purged sandboxes
  match an unknown slug byte for byte; the response never carries another column; the limiter
  bucket is not the `/auth` one; `platform_admin_role` reads `slug` but still not `config`, `plan`
  or `zitadel_org_id`, and cannot change it. Full API isolation 144 files green; worker isolation
  green (five files fail only when run in parallel, and pass serially, as before).
- **Security review.** No blocking or high findings. Fixed: the client now also checks that a logo is
  a png, jpeg or webp data URL before it reaches an `<img>` (the server and the database CHECK
  already did). Accepted, recorded in the spec's R13: the slug is `<name>-<4 digits>`, so a company
  name can be probed for its 10,000 suffixes at 30 requests a minute per address (a longer random
  suffix is the follow-up if it matters), and the per-IP key follows `TRUST_PROXY` like the global
  limiter, falling back to one shared bucket when the peer address is unknown.
