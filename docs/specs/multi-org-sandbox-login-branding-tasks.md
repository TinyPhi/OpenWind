# Implementation Plan: Login-page branding by org slug (R13)

**Spec:** docs/specs/multi-org-sandbox.md (§R13, §V, §T Phase 5, T33–T40)
**Generated:** 2026-10-26
**Status:** implemented on `feat/login-org-branding` (local; PR opens after #1077 merges)
**Dependency:** needs `tenants.logo` and the name edit from PR #1077. Built on the local branch
`feat/login-org-branding` (off `feat/sandbox-branding`); the PR is opened only after #1077 merges,
replaying these commits with `git rebase --onto upstream/main <#1077 tip>`.

---

## Phase 1 — Data and view

**Goal:** a platform admin can read a sandbox's slug, and nothing else new.
**Gate:** db unit tests pass, migration applies on a throwaway Postgres

| task                                                           | requirement | status |
| -------------------------------------------------------------- | ----------- | ------ |
| T33: migration `GRANT SELECT (slug)` to `platform_admin_role`  | R13, R2     | done   |
| T34: `slug` on the sandbox view and every select that feeds it | R13         | done   |

## Phase 2 — API

**Goal:** an unauthenticated brand lookup, and the slug in the handover.
**Gate:** route tests pass + Phase 1 gate still green

| task                                                                  | requirement | status |
| --------------------------------------------------------------------- | ----------- | ------ |
| T35: `GET /public/org-branding/:slug` with its own limiter and config | R13         | done   |
| T36: handover response carries the sandbox's slug                     | R13         | done   |

## Phase 3 — UI, isolation, review

**Goal:** a branded login link works end to end, and the admin can copy it.
**Gate:** §R13 acceptance criteria met; full exit condition green

| task                                                                 | requirement | status |
| -------------------------------------------------------------------- | ----------- | ------ |
| T37: login page reads `?org=` and shows the brand                    | R13         | done   |
| T38: copyable login link; link in handover CSV, clipboard and reveal | R13         | done   |
| T39: isolation tests                                                 | R13, R2     | done   |
| T40: `/security-review`, docs                                        | R13         | done   |

---

## Kick-Off Prompt

Read docs/specs/multi-org-sandbox.md (§R13, Phase 5) and this file. Implement Phase 1 (T33, T34)
first. Do not start Phase 2 until Phase 1 tests pass. Stop and ask on any decision the spec does not
cover. Do not push this branch; the PR waits for #1077 to merge. Log failures with `/spec amend §B`.

---

## Revision 2026-10-27 — login key instead of the slug (spec Phase 6, T41–T48)

The readable slug in `/login?org=` is replaced by a random 16-hex login key stored on the tenant
row (unique, never changed, `NULL` for real tenants). The login card's "OpenWind / Sign in"
breadcrumb and the browser tab title also show the org's name on a sandbox link.

| task                                                                                  | requirement | status |
| ------------------------------------------------------------------------------------- | ----------- | ------ |
| T41: migration `login_key` (unique, CHECK, backfill), grant it, revoke the slug grant | R13, R2     | done   |
| T42: provisioning worker generates the key at creation                                | R13         | done   |
| T43: `loginKey` replaces `slug` on the view, selects and handover                     | R13         | done   |
| T44: `GET /public/org-branding/:key` looks up by key                                  | R13         | done   |
| T45: platform-admin link, CSV, clipboard and reveal use the key                       | R13         | done   |
| T46: login page validates the key, brands the breadcrumb and tab title                | R13         | done   |
| T47: isolation tests for the key                                                      | R13, R2     | done   |
| T48: `/security-review`, docs                                                         | R13         | done   |

---

## Revision 2026-10-28 — blank login page without a match (spec Phase 7, T49–T51)

The login page shows no brand at all (no OpenWind, no org name) on plain `/login`, on every miss and
while a lookup runs; only a valid login key fills in the org's brand, breadcrumb and tab title.

| task                                                                                        | requirement | status |
| ------------------------------------------------------------------------------------------- | ----------- | ------ |
| T49: login page renders no brand, breadcrumb "Sign in", tab title "Sign in" without a match | R13         | done   |
| T50: login page and hook tests for every no-match case and the hit                          | R13         | done   |
| T51: docs and review                                                                        | R13         | done   |
