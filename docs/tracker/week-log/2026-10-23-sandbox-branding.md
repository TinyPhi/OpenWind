# 2026-10-23 — Sandbox name and logo in the app header (R12)

**Session type:** feature (docs/specs/multi-org-sandbox.md R12, T24–T32)
**Branch:** `feat/sandbox-branding` (off `upstream/main`)

- **What.** A sandbox's users now see their org's logo (or a tile with the initials of its name)
  and its name at the top left of the app, beside the hamburger, in place of the OpenWind logo and
  wordmark. The platform admin edits both from the sandbox row's menu ("Edit branding"). Every
  other tenant, the login page and the platform-admin dashboard keep the OpenWind brand.
- **Data.** Migration `0155_sandbox_branding`: nullable `tenants.logo` with a CHECK (png, jpeg or
  webp data URL, at most 140,000 characters, never SVG); a SECURITY DEFINER function that updates
  name and logo only on active `is_sandbox` rows (the 0142 trial pattern, so `platform_admin_role`
  still has no UPDATE on `tenants`); `SELECT (logo)` for `platform_admin_role`; `UPDATE (logo)` for
  `tenant_lifecycle_role` so the purge can clear the tombstone; audit action
  `sandbox.branding_changed`.
- **API.** `PATCH /platform-admin/sandboxes/:tenantId/branding` (name 1–100 trimmed, logo type, size
  and leading-bytes check; 400 on bad input, 404 for a non-sandbox) and tenant-scoped `GET /me/org`
  (returns `null` for a non-sandbox tenant and never an `isSandbox` flag). The audit row, the role
  switch, the change and the read-back share one transaction.
- **UI.** Shared `OrgBrandMark` (logo, initials fallback on a missing or broken image), a
  `useOrgBranding` hook, and a header block that holds the space invisibly while loading so a
  sandbox user never sees OpenWind flash first. The dialog previews the header, checks file limits
  before upload, and can remove or restore a logo before saving.
- **Decisions.** Needs the sign-in's verified MFA flag only (trial-change tier), not a fresh
  step-up code. Invalid input answers 400, the platform-admin routes' convention (the spec had said
  422). Logo is set via Edit after creation, not in the create modal. The Zitadel org name is not
  renamed. Data-URL storage in `tenants`, not `@platform/files`.
- **Tests.** Unit: `sandbox-logo`, the branding route, `/me/org`, db view/audit, tenant purge
  (clears logo), reset (never touches `tenants`), the dialog, the row action, the header. Isolation
  (real Postgres, throwaway container): the function refuses non-sandbox, deleted and out-of-range
  input; the CHECK rejects SVG, gif, remote URLs, markup and oversize; `platform_admin_role` and
  `app_user` have no direct write; `tenant_lifecycle_role` can clear the logo. The existing list
  isolation test's pinned field list gained `logo`. Full API isolation (141 files) green; worker
  isolation green file by file.
- **Reviews.** Security review: no blocking or high findings. Fixed from the code review: header
  name truncation styles, no way to undo "Remove logo", and a post-commit read-back that could turn a
  saved change into a 404 (it now reads in the same transaction).
- **Deferred (low).** No cache header on `GET /me/org` (up to ~140 KB per page load); the platform
  list returns every row's logo; a future CSP must allow `img-src data:`. **Merge order:** #1063
  (migration 0154) must land first; 0155 then renumbers after it, otherwise a database that applied
  0155 would skip 0154. All recorded in the spec's Phase 4 notes.
- **Not run locally.** Root `pnpm test`: it runs the worker isolation suites against whatever
  `DATABASE_URL` points at, which on this machine is the live dev database. It was run once by
  mistake early in the session (the live database was checked afterwards: still 155 migrations, no
  `logo` column, no leftover test rows). Everything after used per-package runs and a throwaway
  Postgres.
