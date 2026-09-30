# 2026-09-28 — Reporting sessions are bound to their tenant by a verified signature (GHSA-28jx-36cp-g34h)

**Session type:** Security fix (developed in the advisory's private fork)
**Advisory:** GHSA-28jx-36cp-g34h (high)
**Branch:** `fix/ghsa-28jx-reporting-binding`

## The problem

Reporting sessions (`analytics_user`) were scoped only by custom Postgres settings that Superset's
connection mutator stamps at connect time: `app.tenant_id`, plus `app.reporting_scope` and
`app.reporting_user_id` for own-rows sessions (migrations `0112`, `0116`). Any session can change
its own custom settings. In Stage 2, a SQL Lab user can run ad-hoc `SELECT`s, so they could run
`set_config('app.tenant_id', <another tenant>)` and read that tenant's rows, or widen their own-rows
scope. This was demonstrated on `main` against a fresh database: a session stamped for tenant A saw
0 rows, re-pointed itself to tenant B, and then read B's ticket. Stage 2 is off by default (it needs
`SUPERSET_OAUTH_CLIENT_ID`), and Stage 1 has no user-written SQL.

## The fix

- **Migration `0128`.** The binding becomes verifiable:
  - a singleton `reporting_binding_key` table, with everything revoked from `PUBLIC`, `app_user` and
    `analytics_user`;
  - a `SECURITY DEFINER` function `reporting_bound_tenant()`. It recomputes
    `HMAC-SHA256(key, tenant|scope|user_id)` from the session's _current_ settings and compares the
    result with `app.reporting_binding_sig`. On any mismatch, a missing signature or a missing key it
    returns NULL;
  - a **restrictive** policy `TO analytics_user` on all six readable tables requiring
    `tenant_id = (SELECT reporting_bound_tenant())`. Platform-global `NULL` rows on `entity_types`
    and `workflows` stay readable;
  - `record_reporting_audit()` now requires the verified tenant.

  Changing any bound setting after connect gives zero rows. It fails closed, and `app_user` is
  unaffected.

- **Superset.** `DB_CONNECTION_MUTATOR` also stamps `app.reporting_binding_sig`. The signature is
  hex, so it can't break out of the options string. `REPORTING_BINDING_SECRET` is required at boot.
  With SSO enabled, chart-data caching is off (`NullCache`): the database applies tenancy per
  connection, so it isn't part of Superset's cache key.
- **Key provisioning.** `run-migrations.ts` upserts `REPORTING_BINDING_SECRET` into the key table.
  It rejects secrets under 32 characters, and rejects the dev default when `NODE_ENV=production`.
  - `turbo.json` now passes the variable through to `db:migrate`. Without that, turbo's strict env
    mode silently dropped it.
  - Compose passes the secret to `superset`, `superset-init` and `bootstrap`, and `.env`/`.env.example`
    carry a dev value.
- **Hardening (ADR-019 OQ-4).** `docker/postgres/init/001_setup.sql` no longer grants
  `analytics_user` `BYPASSRLS` or a default `SELECT`. Migrations `0112`/`0113` already undo both.

## Verification

- New `reporting-binding.isolation.test.ts` (9 cases, as `analytics_user`):
  - a valid binding sees its own tenant only;
  - re-pointing the tenant, widening own-rows scope, switching the bound user, missing or garbage
    signatures, a signature made with a different key, and no installed key all see zero rows;
  - the audit writer refuses an unverified session;
  - neither role can read the key.
- `reporting-grants.isolation.test.ts` now signs its bindings (22 cases pass).
- The Python signer, extracted from `superset_config.py`, produces the same HMAC as the SQL function.
- Key-sync paths checked: short secret rejected, dev default rejected in production, valid secret
  synced.

## Review round 1 (PrabhuVijit, 2026-09-29)

- In production (`NODE_ENV=production`), the migration runner now refuses to run with
  `REPORTING_BINDING_SECRET` unset (exit 1). Before, it warned and exited 0, which left reporting
  empty without anyone noticing. Non-production still warns and continues.
- `.env.example` documents the rotation order: change the value, run `db:migrate`, restart
  Superset. Reporting shows no data between the two.
- The `0128` rollback comment now lists all six `DROP POLICY` statements.
- New isolation case: the binding also holds through the `reporting_instances` view, for both a
  valid binding and a re-pointed one. It fails when the `entity_instances` policy is neutralised.
- The `superset_config.py` comment now says why the cache isn't keyed per tenant.
- **Kept as is:**
  - The test key helpers use `db`. In CI and in the vitest default, that connects as `platform`
    (the database superuser, which also runs migrations), not `app_user`.
  - `console.error` matches the rest of `run-migrations.ts`.
  - The two test files keep their own copy of `bindingSig`. The isolation tests have no
    shared-helper setup.
- **Verified:**
  - key sync: unset in production exits 1; unset in development exits 0 with the warning;
  - api isolation: 113 files / 775 tests on a fresh migrated database;
  - typecheck and lint pass.

## Follow-ups after the advisory is published

- Update ADR-019 (Stage 2 security review closed; record the binding design).
- Operators must set a real `REPORTING_BINDING_SECRET` for Superset and for the migration runner
  before upgrading. In production, migrations now refuse to run without it.
- Close #708 (fixed here) and record the outcome in ADR-019's OQ-6 and Decisions 2 and 6.
