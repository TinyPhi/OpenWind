## 2026-08-13 — connector_definitions default-privileges grant fix + CI migration-role finding

**Session type:** follow-up fix (found while responding to PR #397's review, same session)
**PR:** fix/PLAT-connector-definitions-default-grants
**Branch:** fix/PLAT-connector-definitions-default-grants

While closing out PR #397's review (a fix to `plugin-migration-lint.ts`'s RLS-policy check, plus
5 LOW findings — admin-route guard, install-check on error reporting, blob-URL revocation, stale
task-status doc), the same session had already added explicit `REVOKE INSERT, UPDATE, DELETE ON
plugin_definitions/plugin_errors FROM app_user` in migration 0059, closing a gap where
`docker/postgres/init/001_setup.sql`'s `ALTER DEFAULT PRIVILEGES FOR ROLE migration_user ... GRANT
SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user` auto-grants full DML to app_user on every new
table `migration_user` creates — an explicit `GRANT SELECT` alone doesn't narrow that back down.

`connector_definitions` (migration 0056) has the identical shape: a single `GRANT SELECT ON
connector_definitions TO app_user`, with a comment claiming "writes are migration_user-only (no
INSERT/UPDATE/DELETE grant below)" — same unenforced intent. Migration 0060 adds the missing
`REVOKE INSERT, UPDATE, DELETE ON connector_definitions FROM app_user`.

### Bigger finding: CI can't reproduce this bug class at all

Before writing the fix, checked whether the bug was actually live — and it diverged sharply
between databases:

- `platform` (real dev DB, migrated via `docker-compose.yml`'s `MIGRATION_DATABASE_URL` as
  `migration_user`): app_user had `arwd` (full DML) on `connector_definitions`. Bug confirmed live.
- `platform_test` (CI's test DB, migrated via `.github/workflows/ci.yml`'s
  `DATABASE_MIGRATION_URL` as the **`platform` superuser**, not `migration_user`): app_user had
  `SELECT` only — already correct, because `001_setup.sql`'s default-privileges rule is scoped
  `FOR ROLE migration_user` and never fires when a superuser creates the table instead.

Consequence: **every "app_user write fails with 42501" isolation test in this codebase — including
the ones this same session wrote for `plugin_definitions`/`plugin_errors` — passes in CI for the
wrong reason.** They'd pass identically whether or not the REVOKE statements exist, because CI's
migration role structurally cannot trigger the auto-grant `plugin_definitions`/`plugin_errors`/
`connector_definitions` are each guarding against. The isolation suite gives no real regression
protection for this entire bug class today; it only matters in environments that actually run
migrations as `migration_user` (local dev, and presumably real deployments following the
documented `pnpm db:migrate` flow).

**Deliberately not fixed here** — raised to the human and explicitly deferred, not silently
skipped: changing `ci.yml`'s `DATABASE_MIGRATION_URL` to use `migration_user` instead of the
`platform` superuser would give these tests real teeth, but is a separate, larger, riskier change
than this narrow grant fix, and `.github/workflows/*` edits are off-limits for autonomous agent
work per `CLAUDE.md`. Needs a human decision on whether/when to take on.

### What shipped

- `packages/db/migrations/0060_connector_definitions_grants_fix.sql` — the REVOKE, applied
  directly to both `platform` (where the bug was live) and `platform_test` (already correct,
  applied for migration-set consistency) via `pnpm --filter @platform/db db:migrate`.
- No new isolation test needed — `connector-definitions.isolation.test.ts` already had the
  INSERT/UPDATE/DELETE-denied-with-42501 tests from migration 0056's original PR; they just
  weren't proving what they appeared to prove in CI, per the finding above.
