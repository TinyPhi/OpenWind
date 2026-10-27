# Changelog

All notable changes to OpenWind are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased — on-call teams with members]

### Added

- A team can now hold an ordered list of members. The team page builds a team from org users, shows
  who is on it in rotation order, and lets an admin add, remove and reorder members
  (`PUT /admin/teams/:id/members`; `memberUserIds` on team create). Removing a member, erasing a user
  or deleting a team closes the order up so it has no gaps.
- A team's members are included in the personal-data export.

### Changed

- The on-call roster modal picks the team first, then offers only that team's members for primary,
  backup and escalation manager. The API enforces the same rule for new and changed roles. A team with
  no members keeps the old behaviour, and an existing window that names a former member stays editable.

## [Unreleased — org-view follow-ups (#1072)]

### Changed

- The dashboard now uses a cheap report-availability probe and loads the full Org View only when
  selected, avoiding the subtree and ticket queries on ordinary My View loads.
- Org and subordinate dashboards now warn when their totals are calculated from the newest 2,000
  matching tickets, instead of silently presenting capped counts as complete.
- Invalid org-directory rows without an auth-provider user id no longer appear as team members or
  authorize subordinate dashboard access.

## [Unreleased — configurable platform-admin MFA timings (#929)]

### Added

- `PLATFORM_ADMIN_MFA_VERIFIED_TTL_SECONDS` (default 43200, allowed 900–86400), `PLATFORM_ADMIN_MFA_CODE_TTL_SECONDS`
  (default 600, allowed 60–1800) and `PLATFORM_ADMIN_MFA_MAX_VERIFY_ATTEMPTS` (default 5, allowed 1–5; the per-admin limit across codes is 5 in 30 minutes, so a higher cap would do nothing)
  replace three hardcoded constants. Defaults equal the old values, so behaviour is unchanged unless set.
  The code lifetime must not exceed the verified lifetime. The verification email states the configured
  lifetime in minutes, rounded up.

### Changed

- `@platform/auth` no longer exports `MFA_CODE_TTL_SECONDS`; the route reads the env var.

## [Unreleased — configurable per-tenant retention policy updates (#637)]

### Changed

- The retention bounds are now configurable: `RETENTION_DAYS_MIN`/`MAX`, `RETENTION_COMMENT_DAYS_MIN`/`MAX`
  and `RETENTION_EVIDENCE_DAYS_MIN`/`MAX` (defaults 7–3650, 30–3650 and 365–7300, the values the sweep always
  enforced), checked at startup together with the platform defaults. `RETENTION_REQUIRE_SHORTEN_CONFIRM`
  (default true; only the literal `false` turns it off) controls whether shortening a window needs
  `confirmShorten: true`.

### Added

- **Per-tenant retention policy management endpoint.** Added `PATCH /admin/tenants/:id/retention`
  allowing superadmins in the platform organization to configure noise, comment, and evidence
  retention windows or toggle legal holds on a per-tenant basis.
- **Accidental data loss protection.** Shortening any retention window below the active policy
  (whether via explicit days or by clearing an override back to a default that is shorter than
  the active override) requires explicit confirmation (`confirmShorten: true`), rejecting with
  400 `CONFIRM_SHORTEN_REQUIRED` to safeguard against immediate permanent data loss during sweeps.
- **Override clearance to platform defaults.** Supports passing `null` for retention parameters
  to remove overrides from `tenants.config` and revert to platform defaults.
- **Atomic read-modify-write and audit trail.** Executes inside `withTenantContext` with
  `SELECT ... FOR UPDATE` row locking on `tenants` and writes an immutable audit entry in
  `admin_audit_log` with before and after policy snapshots.
- **Defense-in-depth platform fence.** Unauthorized callers outside `PLATFORM_ORG_ID` receive
  404 before parameter and body validation, preventing tenant existence discovery.

---

## [Unreleased — GDPR data-subject export (#642)]

### Added

- `POST /users/:userId/export` (admin only) builds a JSON file of the personal data stored about one
  user in the tenant; `GET /users/:userId/export/:jobId/download` (admin only) fetches it. The file
  is deleted after `USER_EXPORT_TTL_DAYS` (default 7). `USER_EXPORT_ROW_LIMIT` (10000) and
  `USER_EXPORT_INCLUDE_AUDIT` (true) are also configurable. See `docs/specs/user-data-export.md`.

### Security

- A data-subject export can never be fetched through `GET /exports/:jobId/download`, which agents
  can reach; that route now answers 404 and audits `export.download_denied`.

---

## [Unreleased — per-sign-in platform-admin MFA, login polish and handover CSV (#947)]

### Security

- **Platform-admin MFA is now enforced per sign-in.** Instead of caching verification for 12 hours
  per account across devices, each sign-in requires its own MFA verification code. Successful verification
  issues a cryptographically random session token (hashed in Redis, never stored plaintext), sent via
  `X-Platform-Admin-Mfa` solely to `/api/platform-admin/*` routes. Tokens are terminated on logout, session
  expiry, and step-up verification.
- **Cross-resend brute-force lockout.** In addition to the per-code 5-attempt limit, a persistent failed-verification
  counter with a 30-minute window prevents indefinite brute-force attacks across resends. Five failed attempts
  across resends lock out both `/mfa/request` and `/mfa/verify` (429 with `Retry-After`). The counter is only reset
  on a successful verification.
- **Wrong MFA code answers with 422 instead of 401.** Previously, a 401 response triggered client auth refresh
  and automatic replay, consuming two verification attempts per entered guess.
- **Strict parsing for `PLATFORM_ADMIN_MFA_DEV_BYPASS`.** Replaced `z.coerce.boolean()` with strict literal `"true"`
  validation so that values like `"false"`, `"0"`, or empty strings cannot inadvertently enable the dev bypass.
- **Safe handling of trial-expired and suspended tenant sign-outs.** Added `tenantAccessEndedReason` to distinguish
  403 responses for trial expiration or tenant suspension from standard authorization failures, with validated
  reason banners on sign-out.

### Added

- **Platform-admin sandbox handover CSV download.** Added a "Download CSV" action to the sandbox handover dialog
  with a widened dialog layout.

### UI Polish

- **Tenant login page improvements.**
  - "Need access? Contact us" opens a prefilled product-trial request addressed to `info@rokkalabs.com`.
  - Replaced the placeholder "W" box with the official OpenWind logo and wordmark.
  - Removed outdated footer links (dead docs and privacy hashes, copyright, GitHub link).
  - Streamlined the login card styling by removing the drop shadow while preserving the accent glow.

---

## [Unreleased — migration journal ordering (#895)]

### Fixed

- **A database that stopped just before migrations 0020, 0040, 0050 or 0141 no longer skips them.** The Drizzle
  migrator runs a migration only if its journal `when` is strictly greater than the latest one applied, and
  those four entries shared or trailed their predecessor's. Such a database skipped the migration; for 0020, 0040
  and 0141 a later migration then failed, and for 0050 it was skipped silently. Their `when` values are now just
  after their predecessors', and a new test keeps every journal entry strictly increasing.

---

## [Unreleased — OpenBao production runbook and health alert (#911)]

### Added

- **OpenBao secrets runbook** (`docs/runbooks/openbao-secrets.md`, ADR-023): first-time setup,
  cutover from a running instance (rotate published secrets first, copy data-protecting keys),
  rollback, reboot and unseal order, secret ID, secret and Transit key rotation, certificate
  renewal, an address-binding check, and troubleshooting by loader exit code.
- **`OpenBaoDown` and `OpenBaoSealed` alerts** (critical, 2 minutes) with promtool tests. They stay
  quiet until the OpenBao scrape job, shipped commented out in `prometheus.yml`, is enabled for a
  deployment.

### Changed

- The backup/DR runbook treats the database dump and the OpenBao snapshot as one backup set and
  sets the restore order: OpenBao unsealed, then database, then apps.
- `docs/local-setup.md`: the dev OpenBao loses its data on any restart, not only on a recreate.
  `.env.example`, `docs/deployment-hardening.md`: production OpenBao notes and links.

---

## [Unreleased — OpenBao production guards and secrets client hardening (#935)]

### Breaking change (production only)

With `NODE_ENV=production`, the API and worker now refuse to start when:

- `SECRETS_PROVIDER` is `local` — the local provider's AES key is published in this repo
- `OPENBAO_TOKEN` is set — use AppRole (`OPENBAO_ROLE_ID` + `OPENBAO_SECRET_ID`) instead
- `OPENBAO_ADDR` does not start with `https://` — credentials must not travel over plain HTTP
- `METRICS_TOKEN` is unset or still at its development default — the default is published in this repo
- A Superset secret (`SUPERSET_SECRET_KEY`, `SUPERSET_GUEST_TOKEN_SECRET`,
  `SUPERSET_SERVICE_ACCOUNT_PASSWORD`, `SUPERSET_ADMIN_PASSWORD`) is set to its
  development default

`.env.local` is also no longer read in production — every setting must come from the
container environment (the OpenBao startup loader, ADR-023 Decision 2).

**Before redeploying** any server still using the dev OpenBao or the default `METRICS_TOKEN`,
complete the ADR-023 production setup first. See `docs/runbooks/openbao-secrets.md` and
`docs/deployment-hardening.md`.

### Added

- `packages/secrets`: 5 s request timeout (≈15 s max hold across 3 attempts), retry on
  transient errors (5xx/429/network, never 4xx), token renewal at 2/3 of lease with
  re-login fallback, concurrent callers share one login, 403 rate-limited re-login (at most
  once per 5 s per process), only a short summary of OpenBao's `errors` in logs and thrown
  errors (≤200 chars)
- `packages/config`: production guards for `SECRETS_PROVIDER`, `OPENBAO_TOKEN`,
  `OPENBAO_ADDR`, `METRICS_TOKEN`; Superset secrets are optional in production with no
  default; `.env.local` not loaded when `NODE_ENV=production`; empty `OPENBAO_TOKEN` /
  `OPENBAO_ROLE_ID` / `OPENBAO_SECRET_ID` treated as unset
- `packages/db`: `pnpm --filter @platform/db db:check-local-ciphertext` — read-only
  pre-cutover check that counts `connector_credentials` rows still holding `local:` ciphertext
  (needs `MIGRATION_DATABASE_URL` pointing at production or a read replica)
- `packages/secrets/README.md`: API, provider table, client behaviour, configuration reference
- `decryptCredential` refuses `local:` ciphertext in production (ADR-023 Decision 7)

---

## [Unreleased — OpenBao loader hardening (#962, #963)]

### Security

- **The OpenBao startup loaders no longer follow redirects.** Both the Node and the Python loader now treat any
  HTTP 3xx from OpenBao as a refusal (exit 77, no retry) instead of following it, so the AppRole login or the
  token can't be resent to a host the network check never saw.
- **The loaders revoke their login token when the secret read fails.** Previously a read that gave up (OpenBao
  unreachable until `BAO_WAIT_SECONDS` ran out) skipped the revoke, leaving a live token per restart.

---

## [Unreleased — deleting the last attachment of a comment]

### Fixed

- **Deleting the last attachment of a comment no longer fails.** Removing the only file id from a comment left
  the event's metadata empty-valued (NULL), which the database refused, so the delete returned an error. The
  comment now keeps an empty attachment list.

---

## [Unreleased — Zitadel machine-key expiry digest follow-ups (#953)]

### Added

- **Daily email digest of Zitadel machine-key expiry** (#948). Set `OPS_ALERT_EMAIL` (comma-separated) to
  receive one digest at 06:00 and after a worker start, only when a key crossed a threshold, was replaced or
  went missing; expired, missing and unknown keys repeat daily, never-expiring ones weekly.

### Fixed

- Two overlapping key-expiry runs can no longer both send the digest (short Redis lock, released only by the run
  that took it), and a failed send is retried by the queue (3 attempts, exponential backoff) instead of waiting for the next day.

## [Unreleased — event-log protection (#777)]

### Changed

- **A case's history can no longer be rewritten or deleted by the request role.** `workflow_events` keeps
  its metadata editable (comment attachments, mentions, erasure) but its state and timestamps are now
  fixed for `app_user`, the actor can only be redacted (never re-attributed), and deleting events needs the new `event_log_maintenance_role` (migration 0147).
  The retention sweep, tenant purge and sandbox reset use it. A trigger (migration 0148) also fixes an
  event's recorded `type` and other metadata keys once written; only attachments, mentions, comment text
  and erasure redaction can still edit it.

---

## [Unreleased — retention classes and tenant-context sweeps]

### Fixed

- **The daily retention sweep now actually deletes.** It ran outside tenant context, so under the
  default database role it matched no rows. Both it and the usage-metering sweep now run each
  tenant's work inside the tenant context.

### Added

- **Retention classes for the workflow event log**: state-change history is kept for
  `RETENTION_EVIDENCE_DAYS` (default 2555) and never swept while its case is open or recently
  active; comments use `RETENTION_COMMENT_DAYS` (365); other events use `RETENTION_DEFAULT_DAYS`
  (90). Per-tenant overrides: `retention_days`, `retention_comment_days`, `retention_evidence_days`.
  The comment and evidence defaults are placeholders pending confirmation.
- `tenants.config.retention_hold: true` pauses all retention sweeps for a tenant.
- Batched deletes (`RETENTION_BATCH_SIZE`, `RETENTION_BATCH_PAUSE_MS`) and the
  `openwind_retention_deleted_rows_total{table,class}` metric.

---

---

## [Unreleased — guarded state override]

### Added

- **A recorded, reasoned way for an admin to move a record to a chosen step** outside its workflow's transitions:
  `POST /entities/:id/override-state` with `{ state, reason }`. It is admin-only, needs the workflow's new
  `allowStateOverride` switch (off by default; only a tenant admin can change it, and the change is audited), needs a
  reason of 10 to 1000 characters, and refuses the record's creator. It locks the row, writes the event and an
  admin audit entry (`workflow.state_overridden`) in one transaction, emits `workflow.transitioned` with
  `override: true`, and moves SLA timers like a transition. It counts as acting for segregation-of-duties rules.
- Migration 0146: `workflows.allow_state_override`, and the two audit actions `workflow.state_overridden` and
  `workflow.override_policy_updated`.

## [Unreleased — segregation-of-duties transition conditions]

### Added

- **Three actor-aware transition conditions**: `actor_not_creator` ("the requester cannot approve"),
  `actor_is_creator` ("only the requester may withdraw") and `actor_not_prior_actor` ("each stage needs a
  different person", optionally limited to people who left given states). The engine evaluates them inside
  the transition lock and fails closed: an unidentified actor, an API-key or system identity satisfies none,
  and an actor rule under `not` is never satisfied. No schema change; they live in a transition's existing `conditions`.
  `getAvailableTransitions` takes the actor id, so the list matches the guard.

- **A segregation rule's `states` are checked and protected.** Saving a rule that names a step the workflow does
  not have is rejected with 422 `WORKFLOW_CONDITION_STATE_UNKNOWN` (a typo would otherwise block nobody), and a
  step that a rule names can no longer be renamed or deleted until the rule is changed.
- **Changes to a transition's conditions are audited** (`workflow.transition_conditions_updated`, migration 0145) on create, update, delete and canvas save, so a segregation rule cannot be removed without a record.

### Known limits

- **Not a complete control until #941 merges.** A direct state write (`PATCH /entities/:id` with `currentState`,
  or the child-status route) does not run transition guards, so the record's creator can bypass
  `actor_not_creator`. Do not enable these rules on a real workflow before the guarded override lands.

### Changed

- **Transition conditions are validated when saved.** The create and update transition routes now reject an
  unknown operator or a malformed tree with 400 instead of storing it. A condition nested deeper than 8 levels, or
  a group of more than 20, is rejected.

---

## [Unreleased — mention and notification follow-ups (#952)]

### Fixed

- **@mention and grant lookups no longer drop org members past the first 500.** `listOrgUsers` now pages
  through the whole Zitadel org (capped at 10,000 members, logged when truncated).
- Adding a comment or granting access no longer holds a database connection while it waits on Zitadel:
  membership is read, Zitadel is called, then the new members are recorded in a second short step.
- Creating or updating a ticket with a user-reference field no longer holds a database connection while it waits
  on Zitadel: colleagues who have not signed in yet are recorded before the entity transaction opens.
- A failed Zitadel org-member lookup (for example a rate limit) is no longer cached as an empty org until the
  process restarts; the next mention or grant retries.
- A Zitadel rate limit (429) while resolving a notification recipient now falls back to the cached profile
  instead of treating the user as not found, and recipient lookups run five at a time.

### Changed

- A comment may mention at most 50 people.

---

## [Unreleased — step-up MFA for sandbox reset and delete (#865, #801)]

### Added

- **Sandbox reset and delete now need a freshly verified MFA code** (ADR-022 Decision 10). The 12-hour
  verification still covers list, read, create and trial changes. Reset and delete answer
  `403 MFA_REAUTH_REQUIRED` unless a code was verified within `PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS`
  (default 300, allowed 60–900). The platform-admin dashboard prompts for a code and retries the action.
- **Resend cooldown** for the verification email: `PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS` (default
  30, allowed 5–300). A request inside the window returns `429` with `Retry-After`, and the dialog shows
  the countdown. `POST /platform-admin/mfa/request` now also returns `resendAfterSeconds`.
- `fetchWithAuth` errors in admin-ui now carry the server's error `code`.

## [Unreleased — admin-ui blank-name initials fallback (#850)]

### Fixed

- **Blank or whitespace-only display names now render a `U` avatar initial** consistently across
  admin-ui avatars through the shared initials formatter instead of producing empty avatar text.

---

## [Unreleased — per-ticket notification failure badge (#571)]

### Added

- **`GET /entities/:id/notification-failures`** (agent and admin only): the channels a ticket's
  on-call notification failed on in the last 24 hours, newest first, with the time of each. It
  returns only the channel and the time, never the provider's error text, which stays in the
  admin-only audit log. A ticket the caller cannot see, or another tenant's, is a 404.
- **"Notification failed" badge** on the ticket detail page for admins and agents, showing the
  channels and how long ago the latest failure was.

## [Unreleased — platform-admin logout error feedback (#877)]

### Fixed

- **Failed platform-admin logout attempts now show an inline retry message** instead of rejecting
  silently and leaving the operator without feedback.

---

## [Unreleased — on-call duration metrics and the resolution SLO alert (#570)]

### Added

- **Three on-call routing metrics**: `openwind_oncall_resolution_duration_seconds` (how long
  `resolve_oncall` takes to reach an outcome, labelled by `outcome`),
  `openwind_notification_dispatch_duration_seconds` (time to dispatch one channel, labelled by
  `channel`) and `openwind_notification_policy_match_total` (where in the specificity chain a
  notification policy matched, labelled `matched_at`: `team_workflow`, `team`, `workflow`, `global`,
  `hardcoded_default`). The resolution histogram is recorded at the same points as
  `openwind_oncall_resolutions_total`, so their counts always agree. The histograms use second-scale
  bucket boundaries on purpose: OpenTelemetry's defaults are millisecond-scale, so a 20 ms
  resolution would otherwise read as a p99 of nearly 5 s.
- **`OncallResolutionSLOBreached` alert**: `resolve_oncall` p99 over 100 ms, measured over 15
  minutes because resolutions only happen when a ticket's team changes and can be hours apart.

---

## [Unreleased — coverage-gap badge on tickets (#571)]

### Added

- **"No on-call coverage" badge on the ticket page, for agents and admins.** A ticket that has a team
  and no assignee shows the badge when that team has no active on-call schedule right now, so staff can
  see at a glance that the on-call routing could not assign it. It is never shown to customers, never
  shown once the ticket has an assignee or has reached a closed state, and the page makes no extra request for anyone who cannot
  see it. It uses the existing `GET /admin/on-call-schedules/current`, cached for a minute, so there
  is no API change. A team whose schedule exists but whose people cannot be resolved is not flagged.

---

## [Unreleased — scheduler alert rules (#580)]

### Added

- **Three alerts for the temporal scheduler** in `docker/observability/alert.rules.yml`:
  `ScheduleExecutionFailureRateHigh` (more than 10% of schedule rule fires failing over 10 minutes),
  `ScheduleTickDurationSLOBreach` (tick p99 over 5 s) and `ScheduleExecutionDurationSLOBreach` (fire
  p99 over 10 s, measured over 15 minutes because fires can be hours apart), all warning severity. They need two new histograms,
  `openwind_schedule_tick_duration_ms` and `openwind_schedule_execution_duration_ms`, which the
  worker now records on every tick and every fire (the execution histogram is labelled by status
  only). The histogram buckets run to 60 s on purpose: with OpenTelemetry's default boundaries the
  top finite bucket is 10 s, so a slower fire would never push the p99 over 10 s and the alert could
  not fire.

## [Unreleased — audit trail for permission changes (#640)]

### Added

- **Permission changes are now audit-logged.** Five new `admin_audit_log` actions: `access.granted`,
  `access.updated` and `access.revoked` (per-ticket access grants: direct grant, level change,
  revoke, and approval of an access request), `workflow.admins_updated` (the workflow admin list,
  including the creator becoming the first admin) and `workflow.transition_roles_updated` (which
  roles may fire a transition: creating, editing or deleting one, from the transition routes and
  the canvas save). Each is written in the same transaction as the change, so a change cannot
  commit without its audit entry. A no-op edit writes nothing, and a canvas save writes one entry
  however many transitions changed.
  Migration 0140 widens the action CHECK constraint.
- **A same-tenant access denial on a ticket read or comment is audited.** A customer refused by the
  ticket ACL on `GET /entities/:id` or when commenting now leaves a `ticket.view_denied` /
  `comment.access_denied` entry (actor type `user`), as the third-party API already did. The 404
  response is unchanged, and a missing record is never audited.

### Notes

- User roles live in Zitadel, so a role granted or revoked there is outside this log; only
  OpenWind's own tables are covered. Cross-tenant access attempts are not logged: RLS makes another
  tenant's record indistinguishable from a missing one, so there is no denial to observe.

## [Unreleased — audit log `action` filter]

### Added

- **`GET /admin/audit` can filter by `action`.** `?action=access.revoked` returns only entries with that
  audit action; combine it with `resourceType` and `resourceId` to ask what happened to one ticket, or
  with `from` and `to` for a time window. An unknown action is a `400 VALIDATION_ERROR` rather than an
  empty page, so a typo is visible. One action per request. Admin-only and tenant-scoped as before.
  The same filter is available to code through `queryAuditLog` in `@platform/audit`, which also gains
  an exported `ALL_AUDIT_ACTIONS` list.

## [Unreleased — advisory locks work behind PgBouncer (#752)]

### Fixed

- **Tenant advisory locks now actually exclude concurrent holders behind PgBouncer.** Through
  PgBouncer's transaction pooling, two callers could both be granted the same lock (40 of 40 in a
  reproduction), so org-directory sync and sandbox reset had no real concurrency guard. Set
  `DATABASE_DIRECT_URL` to a direct Postgres `app_user` URL and locks use their own small pool
  (`DATABASE_LOCK_POOL_MAX`, default 5) straight to Postgres. `docker-compose.yml` and
  `.env.example` set it; with it unset, behaviour is unchanged. A lock whose unlock runs on a
  different backend, or fails, now logs an `advisory lock anomaly` error instead of passing silently.

## [Unreleased — "any field" trigger warning (#767)]

### Changed

- **The automation wizard warns when a "Field changed" trigger is scoped to "— any field —"** — an
  inline note says the rule fires on every update to every record of the chosen entity type.

### Added

- **`openwind_mention_record_failure_total` metric** counts resolved mentions the
  mention-resolution worker failed to record on a comment, so incomplete erasure scrubs can be
  alerted on (#769).

## [Unreleased — admin-ui refactors: shared helpers, form state, access state (4 of 5, split from #772)]

### Changed

- **Shared helpers** — `withAlpha` and `avatarColor` (`lib/theme.ts`), `toWorkflowSlug`, `initials`,
  `singularize` and `formatFieldValue` (`lib/format.ts`) and a `useOutsideClick` hook replace
  copy-pasted private versions across admin-ui. The users and roster pages' avatar backgrounds now
  come from the shared `avatarColor`, so they change colour.
- **Form state** — ticket creation, the schedule-rule editor and the notification-policy editor and
  simulator each hold their fields in one typed object instead of one `useState` per field. No
  behaviour change. `ResolvePreview` is renamed `ResolveSimulator`.
- **Ticket access state** — `accessDenied` and the requester's own access-request status are
  derived during render instead of synced by effects, so an approved requester's overlay lifts on the
  next refresh. A failed background `/access` refresh keeps the last good list so the Access
  Restricted overlay can't drop for a denied viewer.

---

## [Unreleased — admin-ui CSS hover states (3 of 5, split from #772)]

### Changed

- **Hover effects in admin-ui are CSS, not React state.** The 24 `useHoverStyle` calls (48
  `onMouseEnter` / `onMouseLeave` props) in the layout, notification bell, pickers, ticket
  create/detail, dashboard, analytics, users, modules, workflow designer and org directory are
  replaced by `:hover` rules in `index.css`, so hovering no longer re-renders components. Accent
  colours still follow the theme through CSS variables and `color-mix()`. `useHoverStyle` stays
  exported from `@platform/ui`; admin-ui no longer uses it.

---

## [Unreleased — admin-ui startup and idle-logout hardening (5 of 5, split from #772)]

### Changed

- **Idle-logout activity listeners are passive and throttled** — the timer resets at most once per
  throttle window (up to 10 s) instead of on every mouse, scroll, touch or resize event, and the
  timeout is still measured from the latest activity, so a dropped event can't log a user out early.
  A rejected `logout()` still redirects to `/login`.
- **User avatars are local initials** instead of images from the DiceBear CDN, and the sidebar logo
  uses the existing `/favicon.svg` (the old `/ow-logo.png` was never in `public/`, so it 404'd).
- **`/env.js` loads with `defer`** so it no longer blocks HTML parsing.
- **The entity-type context value is memoized**, so its consumers no longer re-render on every
  provider render.

### Fixed

- **A browser with blocked storage no longer breaks startup** — theme and accent reads and writes
  fall back to defaults, and a failing initial `getUser()` is caught instead of surfacing as an
  unhandled rejection.
- **A malformed CSS comment** that produced a `css-syntax-error` build warning.

---

## [Unreleased — admin-ui route-level code splitting (1 of 5, split from #772)]

### Changed

- **All 32 admin-ui page routes are lazy-loaded** (`apps/admin-ui/src/lazy-routes.ts`). The entry
  chunk goes from about 1,436 kB to about 660 kB raw (about 402 kB to about 202 kB gzip, Vite's
  units). reactflow and dagre (with their d3 dependencies) now load only with the workflow canvas,
  and the Superset embed SDK only with the Reporting page. The sidebar and header stay mounted
  while a route loads.

### Added

- **Route error boundary** — a page that fails to render or whose chunk fails to load shows a
  message inside the page area instead of blanking the app. A missing chunk offers Reload; any other
  error offers Retry and is logged. A tab left open across a redeploy reloads once to pick up the
  new chunks (guarded against a reload loop).
- **Entry bundle size gate** — `pnpm --filter @platform/admin-ui build` fails if the entry chunk
  exceeds 210 kB gzip (`apps/admin-ui/scripts/check-entry-size.mjs`). Vite's chunk-size warning
  limit drops from 700 to 680 kB raw.

---

## [Unreleased — admin-ui request deduplication and session-scoped caches (2 of 5, split from #772)]

### Changed

- **One `/users` request is shared and cached for 60 seconds** (`fetchUsersShared`). Concurrent
  callers share a single in-flight request. It rejects when the request fails, so callers can show
  an error instead of an empty list; `useUsers()` returns `error`, and `UserRefPicker` shows
  "Couldn't load users" with a Retry button. The workflow records page and ticket detail keep
  falling back to an empty list.
- **Concurrent notification list (first page) and unread-count requests share one in-flight call.**
  A read issued after marking notifications read never joins a request that started before it.
- **The workflow records page fetches its first page of tickets together with the fields and
  users** (one round-trip fewer). A failed first load is retried and then shown as an error rather
  than as an empty board, and a dependency change or a filter toggled away and back no longer drops
  the response or leaves the refreshing indicator on.
- **Ticket detail** reads users from the shared cache and no longer requests comments, attachments
  or tags after a record that failed to load (403/404).

### Added

- **A session-end signal** (`lib/session-events.ts`) emitted on logout, user unload, access-token
  expiry and a refresh the authorization server rejected. The users cache and the notification
  dedup reset on it, so a new login in the same tab never sees the previous identity's data. A
  network error or timeout during a silent refresh does not emit, so a flaky connection doesn't
  flush caches.

---

## [Unreleased — MIS reporting (Stage 1 embedded + Stage 2 standalone)]

### Added

- **Embedded Superset reporting (track 3G, Stage 1)** — A Reporting page in admin-ui. Admins and
  agents get two dashboards (Tenant Overview, My Performance); customers get only their own. Users
  never see a Superset login: the API mints a 60-second, row-filtered pass per request and the embed
  SDK exchanges it. A filter bar led by the date range, with Status, Department, Assignee and
  Priority; on My Organisation Overview the SLA watch table sits directly under the four KPI numbers,
  and each ticket row links straight to the ticket in OpenWind. Superset
  starts with the rest of the stack on a fresh clone (`COMPOSE_PROFILES=reporting`), bound to
  loopback only, and provisions itself: a dedicated guest role, a read-only data connection, and both
  dashboards addressed by slug rather than hardcoded identifiers.
- **Standalone Superset with Zitadel sign-in (Stage 2)** — optional, off unless
  `SUPERSET_OAUTH_CLIENT_ID` is set. Roles are re-synced at every login; non-staff are narrowed to
  their own tickets by the database, whatever query they write. Every query and export is recorded
  in the platform audit log (`reporting.query_executed` / `reporting.exported`).
- **Helpdesk tickets gain a `department` field** (optional select).

### Security

- **Reporting tenant isolation is enforced by the database, not by a filter** (migration 0112).
  `analytics_user` no longer bypasses row-level security; Superset stamps the caller's tenant onto
  each connection, so the platform's RLS policies apply to reporting queries exactly as they do to
  the API. A connection with no tenant returns no rows.
- **Own-rows boundary in the database** (0116) — a restrictive policy limits non-staff reporting
  sessions to tickets they raised or are assigned.
- **PII withheld by grant, not masked by a view** (0117–0124) — the reporting role cannot read
  `workflow_events.metadata`, `entity_instances.fields`/`search_vector` or `tenant_users.email`;
  reporting reads trigger-maintained projection columns instead. The old `workflow_events_masked`
  view executed with its owner's privileges, so RLS did not apply through it; it has been dropped
  (0119). The role reaches only the reporting tables (0113), and `pg_stat_statements` is no longer
  readable by `PUBLIC`.
- **Guest dashboard permissions no longer land on the anonymous role.** They were granted to
  Flask-AppBuilder's `Public` role, which is the role given to unauthenticated visitors, leaving
  Superset's dashboard/chart/dataset APIs answering `200` with no credentials. Provisioning now
  revokes them from `Public`, grants them to a dedicated `EmbeddedViewer` role, and refuses to run
  if the guest role is ever pointed back at `Public`.
- **Superset secrets fail startup in production when left at their development defaults**, rather
  than running on a published signing key — the mechanism behind CVE-2023-27524's attack class.
  The browser-facing and container-internal URLs are also validated as different in production.

### Fixed

- **Sign-in no longer overwrites stored display names with the user id** when the token carries no
  name.
- **Login failures before the redirect are logged** instead of silently resetting the button.

---

## [Unreleased — MIS reporting dashboards (spec only)]

### Added

- **Reporting dashboard specs (Apache Superset)** — Two specs replacing the Metabase-era reporting
  design: `docs/specs/superset-embedded-dashboarding.md` (Stage 1 — fixed dashboards embedded in
  admin-ui, tenant overview for admin/agent and my-performance for all roles) and
  `docs/specs/superset-standalone-with-zitadel.md` (Stage 2 — Superset on its own URL with Zitadel SSO
  for analysts). Design only; no runtime behaviour changes. Roadmap track **3G** added, with
  reporting moved out of the 2D row. Implementation is gated on an ADR for the reporting
  tenant-isolation boundary (#102–#106).

---

## [Unreleased — dashboards and alerting (Stage 4)]

### Added

- **Grafana dashboards provisioning** — Auto-configured Prometheus datasource and provisioned "OpenWind Platform" dashboard displaying API traffic rates, latency percentiles, error rates, and queue depths (#507).
- **Alertmanager alerts configuration** — Mounted `alertmanager.yml` SMTP configuration pointing to local Mailhog container for developer alert emails (#507).
- **Prometheus alerting rules** — Added alert rules (`QueueDepthHigh`, `HttpErrorRateHigh`, `HttpLatencyHigh`) targeting BullMQ queue depth backups, HTTP latency, and 5xx error rate spikes (#507).

---

## [Unreleased — compliance and data retention (Stage 3)]

### Added

- **GDPR per-user erasure endpoint** — Added `DELETE /users/:userId` route restricted to tenant admins, transactionally deleting user views, alerts, notifications, and api keys, and anonymizing user references across tickets, workflows, and events (#506).
- **IP allowlisting auth check** — Added client IP validation middleware (`enforceTenantIpAllowlist`) in Hono auth middleware resolving matching single IPs/CIDR subnets from `tenants.config.ip_allowlist` (#506).
- **Retention archival daily sweep** — Implemented repeatable BullMQ worker `retentionArchivalWorker` running daily at 04:00 to purge tenant workflow events, outbox events, and usage metrics older than `tenants.config.retention_days` (#506).

---

## [Unreleased — usage metering and plan enforcement (Stage 2)]

### Added

- **Usage aggregation table** — Added `tenant_usage_daily` with strict Row-Level Security (RLS) policies, indexing on query patterns, and analytics annotations (#505).
- **Billing plan gate middleware** — Implemented `billingGate()` peer logic in Hono (`enforceTenantBillingGate`) incrementing daily API calls and blocking file uploads if storage quota is exceeded (#505).
- **Daily usage flusher worker** — Implemented scheduled BullMQ job `usageMeteringWorker` aggregating storage bytes and Redis counters, writing daily records, and triggering Novu plan alerts on state transitions (#505).
- **Plan degradation banner** — Global error banner listens for `X-Tenant-Degraded` responses and renders a dismissible warning banner linking to settings (#505).

---

## [Unreleased — network status awareness (admin-ui)]

### Added

- **Global network status banner** — `apps/admin-ui` now shows a distinct "You're offline" /
  "Reconnecting…" / "Back online" banner instead of silent per-page failures when connectivity
  drops. A same-origin `/api/health` probe is the source of truth; `navigator.onLine` and the
  notifications socket's state are corroborating hints only (#403).

### Fixed

- **Transport failures now surface a banner** — `doFetch()`'s catch previously threw silently on
  a network error or timeout with no `api:error` dispatch at all; it now signals the new network
  status store (#403).

---

## [Unreleased — loopback host port mappings (Postgres, PgBouncer, OpenBao)]

### Security

- **Loopback-only host ports** — `postgres`, `pgbouncer`, and `openbao` host port mappings in
  `docker-compose.yml` are now restricted to `127.0.0.1` (loopback only) instead of `0.0.0.0`,
  preventing direct external network access to the database (dev credentials) and OpenBao
  secrets manager (`-dev` mode static root token) on server deployments (#454, #455).

### Added

- **`OPENBAO_HOST_PORT`** & **`PGBOUNCER_HOST_PORT`** env vars — allow remapping OpenBao and
  PgBouncer host ports without editing `docker-compose.yml` directly (#454, #455).

---

## [Unreleased — redis host port mapping]

### Added

- **`REDIS_HOST_PORT`** env var — remaps Redis's host port the same way `POSTGRES_HOST_PORT`/
  `ADMIN_UI_HOST_PORT` already do, fixing host-mode `pnpm test`/`pnpm dev` previously being
  unable to reach Redis at all (it had no host port mapping). Binds loopback-only
  (`127.0.0.1`), since Redis has no authentication configured.

---

## [Unreleased — ticket due date]

### Added

- **Ticket due date** — every ticket now has a system-level `due_date`, independent of workflow
  state/SLA, editable by ticket-access users. Passing the due date fires a new
  `entity.due_date_overdue` automation trigger via its own decoupled outbox scheduler/worker, so
  `automation_rules` can notify on it without touching SLA machinery. Migration 0052.

### Changed

- **Breaking**: `PATCH /entities/:id` (state changes on child tickets, `assignedTo`, `dueDate`,
  and `fields` edits) is now restricted to the record's creator, admin/agent, or a workflow
  admin — a user who is only the record's **assignee** no longer has write access and now
  receives `404`. Previously the assignee was treated the same as the creator/owner.

### Fixed

- `apps/admin-ui/Dockerfile.dev` now builds workspace package dists (e.g. `@platform/ui`) before
  starting the dev server — a freshly-built image previously failed at runtime with
  `Failed to resolve entry for package "@platform/ui"`.

---

## [Unreleased — child tickets, tender module, access requests]

### Added

#### Ticket & record features

- **Child tickets** — break any ticket into sub-tasks with their own workflow state, assignee, and due date. Depth (`max_child_depth`) and fan-out (`max_children_per_parent`) are configurable per workflow; archiving a parent cascades to its active children.
- **Access requests** — a non-privileged user can request read/comment/write access to a record they don't own; an admin, agent, or the record's owner approves or rejects, with a full history event and the grant applied atomically with the resolution.
- **Attachments** — file uploads on tickets and comments via presigned S3-compatible URLs, gated by the same record-level access check as the record itself.
- **My Tickets** (`GET /entities/my-tickets`) — a user-scoped view combining a customer's own tickets, tickets they're mentioned/granted access on, and their children, with per-workflow counts.
- **Multiple workflow admins** — `workflows.assigned_to` is now an array instead of a single user; the workflow detail page's settings access supports any number of designated admins.
- **Cross-org / instance-admin actor resolution** — activity history now resolves display names for users outside the record's own org (via a single-user Zitadel lookup fallback), instead of showing a truncated ID.

#### Modules

- `tender` — 8th standard module: tender/bid entity type, costing and approval sub-tasks via the child-ticket mechanism, Draft → Published → Bidding → Awarded/Closed workflow.

#### Database

- Migration 0025 — `workflows.assigned_to` changed from `text` to `text[]`
- Migration 0026 — soft-delete columns on `entity_relations`
- Migration 0027 — `max_child_depth` / `max_children_per_parent` on `workflows`
- Migration 0028 — `access_requests` table with RLS
- Migration 0029 — `file_attachments` table with RLS
- Migration 0030 — `files.uploaded_by` changed to `text` (Zitadel snowflake IDs)
- Migration 0031 — `resolve_api_key_by_hash` SECURITY DEFINER function (API-key lookup under RLS)
- Migration 0032 — `access_requests` `app_user` grant (was missing from 0028)
- Migration 0033 — `CHECK` constraints on `max_child_depth` / `max_children_per_parent`

### Fixed

- Record-level ACL (`__accessUsers`) reads (`GET /:id/access`, child ticket listing) now consistently require the same read-access gate as the record's own `GET` route
- `read_only` access level was silently ignored by the read-access check — users with that grant always got a 404
- Several routes issued bare (non-`withTenantContext`) DB queries, silently returning empty results or throwing RLS violations under real-role enforcement (`automation-rules`, `api-keys`, `admin/audit`, `view-configs`, `entities/set-child-status`)
- CSV/XLSX export sanitizes leading `=`/`+`/`-`/`@` characters to prevent formula injection into spreadsheet apps
- JWT audience validation now fails closed instead of skipping the check when `ZITADEL_AUDIENCE` is unset
- Automation recursion depth is now carried through the outbox payload, preventing `MAX_DEPTH` from being silently reset on outbox-routed automation loops
- Auth middleware no longer force-writes `tenant_users` on every authenticated request (was an unconditional `onConflictDoUpdate`; now SELECT-then-conditional-write)
- `loadEntityType` (entity engine internal helper) now applies an explicit tenant filter matching `loadEntityFields`, instead of relying on RLS alone — closes the last helper in `engine.ts` missing the mandatory second isolation layer (#220)
- `deleteWorkflowState` checks if the deleted state is set as the workflow's `initialState` and throws `WORKFLOW_STATE_IN_USE` to block it (#310)
- Export worker and download route handler propagate `TENANT_DEACTIVATED` error code instead of confusingly mislabeling it as `EXPORT_EXPIRED` (#308)
- Background workers unified and deduplicated `isTenantActive` validation checks using a shared tenant guard (#306)

---

## [Unreleased]

### Security

- **Rate limiter no longer buckets on an unverified JWT claim** (#195) — the pre-auth flood guard
  used to decode (not verify) a bearer token's `org`/`sub` claim and bucket on it when present,
  letting a client evade its rate limit entirely by varying an unforgeable claim per request. The
  pre-auth stage now keys strictly on client IP; a new post-auth, tenant-scoped stage inside
  `requireAuth()` (`@platform/auth`) enforces the real per-tenant limit (100 req/min default) on the
  verified `auth.tenantId`, for both JWT and API-key traffic. Both stages share one sliding-window
  Redis implementation (moved to `@platform/redis`), which now fails open within a bounded 250ms
  timeout instead of potentially hanging a request if Redis is unreachable.
- **RLS on entity_types, workflows, workflow_states, workflow_transitions** — these four tables
  previously had no database-level tenant isolation, relying solely on application-layer ownership
  checks. `entity_types`/`workflows` now enforce a nullable-tenant RLS policy pair (system/template
  rows readable by all tenants, writable by none via the app role); `workflow_states`/
  `workflow_transitions` gained a `tenant_id NOT NULL` column and a standard tenant-scoped RLS pair.
  See ADR-007.

### Changed

- **API error responses** — workflow and entity engine errors now return human-readable `message` fields instead of raw error codes. Affected codes: `INSTANCE_NOT_FOUND`, `TRANSITION_NOT_AVAILABLE`, `TRANSITION_FORBIDDEN`, `TRANSITION_LOCKED`, `CONDITION_NOT_MET`, `REQUIRED_FIELDS_MISSING`, `ENTITY_NOT_FOUND`, `FIELD_VALIDATION_FAILED`, and others. Clients that match on `error` code are unaffected; clients that display `message` directly will see improved copy.

### Fixed

- **Automation `assign`/`create_entity` actions were declared but never dispatched** (#191) — a
  rule using either action type saved successfully and silently did nothing. Both are now wired
  up: `assign` writes `assignedTo` via `updateEntity`; `create_entity` creates a new instance via
  `createEntity`. See #218 for a known follow-up limitation this surfaces (unbounded recursion risk
  for a self-triggering `create_entity` rule, since `entity.created`'s outbox payload doesn't carry
  automation depth the way `entity.assigned`'s does).

### Added

#### Admin UI

- Full admin application built with Refine + shadcn/ui:
  - Dashboard with KPI cards, module status, workflow counts, and entity-type summary
  - Workflow list with colorful per-row accents, mini state-flow visualisation, and search
  - Workflow detail — KPI strip, fields/states/transitions tables, inline editing
  - Templates (modules) page — install/uninstall modules with search and filter tabs
  - Entity type management — fields CRUD, instance list, instance detail
  - Customer records navigation — per-entity-type record lists with workflow-aware columns
  - Record detail — UX4G two-column layout, available transition buttons (previously broken), colored state badges, activity timeline
  - Dark/light theme with OS-preference detection and manual toggle
  - Responsive design at 900px / 768px / 640px / 480px breakpoints across all pages

#### Portal UI

- Customer-facing portal rebuilt from scratch:
  - Record list with workflow state badges and priority chips
  - Record detail with transition actions, field display, and activity history
  - Record create form with dynamic field rendering
  - Zitadel OIDC auth with role-based redirect (admin/agent → admin-ui, customer → portal)

#### API

- `GET /modules` — list all registered modules with per-tenant installed status
- `POST /modules/:slug/install` — install a module for a tenant (runs seed SQL)
- `POST /modules/:slug/uninstall` — uninstall a module and remove tenant config
- `GET /admin/view-configs/:entitySlug` — fetch view configuration for an entity type
- `POST /admin/view-configs/:entitySlug` — install default view configs
- `PATCH /admin/view-configs/:entitySlug` — override layout configuration
- `GET /platform/roles` — list Zitadel roles for the organisation
- `GET /platform/users` — list tenant users with display names
- `PATCH /workflows/:id` — update workflow name and active state
- `is_active` field on workflows — toggle workflows active/inactive (portal filters to active only)

#### Database

- Migration 0008 — `modules` table with RLS (tenant-scoped module registry)
- Migration 0009 — `view_configs` table with RLS (per-tenant layout overrides)
- Migration 0010 — `email` and `display_name` columns on `tenant_users`
- Migration 0011 — `is_active` boolean column on `workflows` (default `true`)

#### Modules (seed SQL)

- `helpdesk` — tickets, comments, articles, SLA workflow, automation rules, view configs
- `crm` — contacts, companies, deals, pipeline workflow
- `hrms` — employees, departments, leave requests workflow
- `reimbursements` — expense claims, approval workflow
- `projects` — tasks, milestones, project workflow
- `invoicing` — invoices, quotes, payment workflow
- `procurement` — purchase orders, vendor management, approval workflow

### Fixed

- Workflow transitions were never fetched or rendered in the customer record detail page
- Module seed registry was not auto-populated on first list request
- Helpdesk seed rewritten as a single DO block to fix install errors on Postgres simple protocol
- Type cast errors in seed SQL for Postgres simple protocol
- `admin_audit_log`'s action allowlist never included `purge.completed`/`purge.failed` — every
  real tenant purge has been silently failing its completion/failure audit-trail write

---

## [Unreleased — modular]

### Added

#### Admin UI — RBAC & access control

- **Role-based route guards** — `RequireAdmin` component wraps admin-only routes (`/users`, `/entity-types`, `/workflows` list/create); non-admin users are redirected to `/dashboard` instead of seeing a blank page or a 403
- **Workflow settings access for assignees** — users assigned to a workflow can now open its settings page; access is checked inside the component (admin or workflow assignee)
- **Templates page** — available to all authenticated users (previously admin-only); agents and customers can browse installed modules
- **Settings page** — accessible to all authenticated users; was previously gated too aggressively
- **Dashboard highlight** — active module cards are visually highlighted; the dashboard now surfaces the user's assigned workflows

#### Admin UI — User assignment

- **Searchable user picker** — `UserPicker` component with async search, avatar initials, and role badges; used for assigning users to entity instances
- **Assigned-to field** — create and edit forms surface the assignee picker; workflow records list shows the assigned user
- **Always-visible "New record" button** — previously hidden when no records existed; now always shown

#### Admin UI — Workflow detail

- **Workflow assignee field** — workflow settings page exposes an assignee picker so workflows can be owned by a specific user
- **Template preview modal** — clicking a template card opens a modal showing states, transitions, and field definitions before install
- **Dirty-state navigation guard** — leaving the workflow settings page with unsaved changes triggers a browser confirmation prompt (`useBlocker`)

#### Admin UI — Layout & UX

- **Records sidebar nav item** — links to `/records` alongside Automations, Workflows, and Templates
- **Full-width activity section** — record detail activity feed spans the full panel width for better readability
- **User-picker dropdown portal** — dropdown renders via React portal to escape `overflow:hidden` / z-index clipping in scroll containers

#### API

- `GET /platform/users` — filters users by organisation (Zitadel org scope) using the v2 userservice endpoint
- `assigned_to` field support on entity instances — create, update, and list routes accept and return the assignee user ID
- Migration `0020` — `assigned_to TEXT` column on `entity_instances` (nullable, no FK — user IDs are managed by Zitadel)
- Migration `0021` — entity `user_id` columns changed from UUID to TEXT to match Zitadel's string user IDs

#### Portal

- Zitadel OIDC auth — portal now authenticates via the same OIDC flow as admin-ui; role-based redirect sends customers to portal, agents/admins to admin-ui

#### Developer experience

- **Single-command setup** — `setup.sh` / `setup.bat` bootstraps the entire stack from zero: Postgres, Redis, Zitadel (generated at runtime, not committed), migrations, seed data, demo users
- **Modular Zitadel** — Zitadel is no longer inlined in `docker-compose.yml`; it runs as a separate compose project, joined via the `openwind_zitadel` external Docker network. This keeps the identity provider decoupled from the app stack
- **Service name prefixes** — all app containers renamed to `ow-*` (`ow-backend`, `ow-frontend`, `ow-database`, `ow-cache`, `ow-pgbouncer`) for clarity in multi-project Docker environments
- **Bootstrap container** — `Dockerfile.bootstrap` + `bootstrap` compose service runs migrations, seeds, and Zitadel config in one idempotent pass; safe to re-run
- **Configurable host ports** — `POSTGRES_HOST_PORT`, `ADMIN_UI_HOST_PORT` env vars let you remap host ports without editing compose files (useful when defaults conflict with other local services)

### Changed

- `docker-compose.yml` — Zitadel service removed from main compose; `openwind_zitadel` external network moved to the gitignored `docker-compose.server.yml` overlay so `docker compose up -d` works on a fresh clone with no external network pre-created
- `vite.config.ts` — `allowedHosts` and proxy target are now env-var driven (`VITE_ALLOWED_HOSTS`, `VITE_API_PROXY_TARGET`); neither is set in a default local checkout

### Fixed

- API calls from the admin-ui container now route through the Vite proxy (`/api`) instead of hitting `localhost:3000` directly (which is unreachable inside Docker)
- User-picker dropdown clipped by scroll containers — fixed with a React portal
- `assigned_to` field rejected UUID validation — relaxed to TEXT to match Zitadel string IDs
- Zitadel service account key parsing — added PKCS#1/PKCS#8 fallback and base64 decode path
- Portal auth redirect loop — portal now correctly identifies customer role and stays on portal routes
