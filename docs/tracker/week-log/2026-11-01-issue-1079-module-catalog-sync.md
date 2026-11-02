## 2026-11-01 — #1079: module catalog written by the migration role (ADR-005 Amendment 1)

### Done

- Moved the `standardModules` array out of `ModuleService.seedRegistry()` into
  `packages/db/src/module-catalog.ts` (`MODULE_CATALOG`, zod-typed) with an idempotent
  `syncModuleCatalog` upsert keyed on slug. `packages/db/src/run-migrations.ts` runs it as
  `migration_user` after the migrations on every invocation. It refreshes name, description,
  version, `is_system`, `min_plan`, `category`, `updated_at` and never touches `is_visible`.
- Removed `seedRegistry`, `POST /modules/seed`, the `listModules` empty-registry auto-seed and the
  admin-ui "Seed Templates" button. `scripts/seed-demo.ts` and `scripts/reset-data.ts` re-sync via
  `syncModuleCatalogAsUrl` (reset-data clears and re-syncs in one transaction);
  `vendor-approval-demo.ts` asserts the catalog; bootstrap step 9 text corrected.
- API startup (`apps/api/src/lib/module-catalog-assertion.ts`) reads the catalog as `app_user` and
  exits non-zero on an empty one, naming the migrate/bootstrap step and `docs/local-setup.md`.
- Migration 0159: `GRANT UPDATE (is_visible, updated_at) ON modules TO app_user` so
  `ModuleService.setVisibility` works again (mirrors 0062 on tenants).
- Tests: unit tests for the catalog, the sync and the assertion; an opt-in fresh-database suite
  (`module-catalog-fresh-db.isolation.test.ts`) that migrates as the real `migration_user` and
  connects as a real `app_user` login; existing tests switched from `seedRegistry` to the sync;
  `is_visible` allowed / `category` denied cases added to the global-catalogs write-restriction suite.
- Docs: `docs/local-setup.md` (catalog section, "API exits: module catalog is empty"),
  `modules/tender/README.md`, `docs/specs/module-upgrade-workflow.md`, the vendor-approval runbook,
  CHANGELOG.

### Recorded choices (open questions from the amendment)

- Startup assertion fails on an empty catalog only (not on a missing expected slug); no
  `NODE_ENV=test` skip, since tests do not run `index.ts`.
- Scope is `modules` only; `connector_definitions` / `plugin_definitions` are empty by design and untouched.
- The worker's `MIGRATION_DATABASE_URL` and a compose `migrate` service are left as they are (deferred).

### Verification

See the PR body for the per-command table.

### Next

- Owner: decide whether CI should run the fresh-database suite (needs a Postgres with the
  `app_user`/`migration_user` roles and a `CATALOG_TEST_ADMIN_URL`; a workflow change).
- Fix migration 0158 so a fresh `migration_user` migration works (found while verifying; see PR).

### Open questions

- Compose `migrate` service so `docker compose up -d` alone yields a catalog (deferred).
