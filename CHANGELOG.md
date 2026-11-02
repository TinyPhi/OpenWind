# Changelog

All notable changes to OpenWind are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased — Indic font unicode-range and language selector gate (#1092, #1110)]

### Added

- `TRANSLATED_LANGUAGES` constant gating the language switcher so untranslated locales (currently all non-English stubs) display a localized "Coming soon" pill badge and are disabled until full translations are ready (#1110).
- Restored Google Fonts Indic `@import` font delivery with full glyph coverage and verified download-on-demand behavior (#1092).
- Unit tests for the Settings Language tab (`settings.test.tsx`) and Refine `i18nProvider` (`i18n-provider.test.ts`) (#1110).
- Extended `locale-completeness.test.ts` to assert that enabled locales in `TRANSLATED_LANGUAGES` provide translated values.

### Changed

- Stored language selections for untranslated locales fall back to 'en' without modifying existing stored preferences.
- Validated language selections against `TRANSLATED_LANGUAGES` before applying language changes or setting `document.documentElement.lang`.

## [Unreleased — Superset erasure enablement check (#1137)]

### Added

- `SUPERSET_DEPLOYMENT` (`off` default, `on`): says whether an install runs Superset. Read by the API and the
  worker. `off`: no Superset is expected, the self-check records `skipped`, a user erase answers `disabled`,
  a tenant purge does not wait on Superset, nothing alerts and no other Superset variable is needed. `on`:
  the self-check is mandatory and erasure fails closed (see Changed).
- Superset `GET /openwind/erasure/status` (service account only) reports whether Stage 2 and erasure are on
  there. A worker BullMQ repeatable job (queue `superset-erasure-selfcheck`, fixed job id, one run per
  interval however many worker replicas) compares it with the local setting, runs a no-op smoke erase for a
  synthetic tenant, and records the result in Redis. New settings `SUPERSET_SELFCHECK_INTERVAL_MINUTES`
  (default 15) and `SUPERSET_SELFCHECK_TTL_MINUTES` (default 30, at least twice the interval). New metrics
  `openwind_superset_erasure_selfcheck_total{outcome}` and `openwind_superset_erasure_config_mismatch`; new
  alerts `SupersetErasureConfigMismatch` and `SupersetErasureSelfcheckFailing`; `SupersetErasureFailed` also
  covers `outcome="unverified"`.
- API: `DELETE /users/:userId` can answer `superset.status: "unverified"` (additive enum value, HTTP 200). It
  also writes a `superset_erasure.failed` audit row (existing action, no migration) with
  `metadata.status: "unverified"` for the reconciler (#1138).

### Upgrade note

- **Existing deployments that run Superset must set `SUPERSET_DEPLOYMENT=on`** on `ow-backend` and `ow-worker`.
  `docker-compose.prod.yml` now defaults it to `on` for both; with `docker-compose.yml` and the `reporting`
  profile, set it in `.env`. Left at `off`, the worker's self-check still notices a Superset that reports
  Stage 2 on (a `mismatch` alert) and erasure still runs in full, but a Stage 1 install would flush nothing.
- `SUPERSET_ERASURE_ENABLED` is removed from the settings: it is ignored, and the API and worker log a startup
  warning if it is still set. Remove it. Installs without Superset need nothing: `off` is the default.
- An `SUPERSET_OAUTH_CLIENT_ID` set while `SUPERSET_DEPLOYMENT` is `off` logs a startup warning. The id no
  longer decides whether erasure is enabled; with the deployment `on` it only tells Stage 2 from Stage 1.

### Changed

- Erasure fails closed when Superset's Stage 2 state cannot be confirmed (deployment `on` only). A user erase
  with the local mode "cache-only" and no fresh self-check answers `unverified` (200, admin-ui warning)
  instead of "Superset holds no account"; the tenant purge job fails and retries instead of completing. When
  Superset reports Stage 2 on, user erase, tenant purge and the cache flush run in full even if this service
  has the flag `off` or no `SUPERSET_OAUTH_CLIENT_ID`.
- The Superset cache flush with the flag `off` is logged at info instead of warn.

## [Unreleased — org chart and idle logout]

### Changed

- The org chart opens fully expanded for an organisation of 60 people or fewer. Before, it showed only the
  first three levels, so a chain of managers hid most people behind collapsed cards.
- A signed-in session now logs out after 15 minutes of inactivity by default (was 5).
  `VITE_IDLE_LOGOUT_TIMEOUT_MINUTES` still overrides it.

## [Unreleased — recurring on-call rotation]

### Added

- A roster can repeat every 3 to 90 days. The roster modal has a "Repeat every N days" option; a worker
  then creates each next window by itself, moving primary and backup to the next people on the team
  (wrapping, and never the same person twice). A manual window that overlaps the next one stops the
  rotation and shows why, instead of being overwritten, and it resumes once the overlap is cleared.
- The people taking over are told once, in the app and by email, when their window starts within two days.
- The roster page shows which windows belong to a repeating roster and has a panel with the cycle, status,
  next window and who is next, with stop, resume and end-date controls. Stopping keeps every window.
  New endpoints: `/admin/on-call-rotations` (list, patch, delete = stop).
- Upcoming windows of a running roster show on the roster calendar as a light, dashed preview; clicking one
  opens a read-only view.

### Changed

- All repeating-roster controls moved into the roster edit modal: a Repeat automatically checkbox, pause and
  resume, delete with a clear warning, and a choice to keep or change this window's end when repeat is turned
  off. Round green, yellow and red buttons (save, pause, delete) sit at the bottom right.
- Pausing a roster removes the windows that have not started, so another roster can use that time; only one
  roster runs per team, so a paused roster cannot be resumed once another is active.
- A window's end is calculated from its start and the cycle length. A window that is running can have its end
  moved; editing a repeating window's length updates the roster's cycle and the next window.
- A person can be on only one team at a time, enforced by the database as well as the API, so two admins
  saving at once cannot put someone on two teams. The team member picker is a searchable multi-select that
  lists only people not on another team.

## [Unreleased — schedule rules page]

### Changed

- New schedule rules default to India time (Asia/Kolkata) instead of UTC. Existing rules keep the zone they
  were saved with.
- The rule list uses round icon buttons (pause or resume, edit, delete). Pausing and deleting now ask for
  confirmation first, and the warning says what happens to missed fire times and to records already created.
  Resuming has no warning.

### Removed

- The Archive button on the rule list. Pausing a rule does the same job. The API still accepts the archived
  status, and rules archived earlier still show.

## [Unreleased — module catalog sync (#1079)]

### Fixed

- The module catalog (`modules`, which drives the Templates page and which modules new tenants
  get automatically) is now written by `pnpm db:migrate` / the `bootstrap` container as
  `migration_user`, on every run, instead of by the API at runtime. Since migration 0061 the API
  role could not write it, so a fresh database stayed empty and catalog changes never applied.
  The admin visibility toggle works again (migration 0159, column-scoped grant on `is_visible`).

### Changed

- **Operators must run the migration step** (`pnpm db:migrate`, or `docker compose --profile
bootstrap up bootstrap`) on a fresh database and after any change to the catalog. The API now
  exits non-zero at startup, with a message naming that step, when the catalog is empty.
- Removed `POST /modules/seed`, the "Seed Templates" button and the empty-registry auto-seed.
  `pnpm seed:demo` and `pnpm reset:data` need `MIGRATION_DATABASE_URL` and re-sync the catalog.

## [Unreleased — migration 0158 fresh install (#1153)]

### Fixed

- Migration 0158 (`access_log_retention_role`) no longer stops a from-scratch migrate as the
  non-superuser `migration_user`. The unconditional `ALTER ROLE` is replaced by an attribute check that
  raises on a pre-existing role with unsafe attributes (and repairs it only for a superuser). Edited in
  place; databases that already applied 0158 are unaffected.

## [Unreleased — OTel/Sentry upgrade (#793)]

### Security

- Upgraded `@sentry/node` to 10.x and removed an unused OTel 1.x metrics dependency, clearing
  the open CVEs on OpenTelemetry 1.x. Sentry captures traces and errors directly.
