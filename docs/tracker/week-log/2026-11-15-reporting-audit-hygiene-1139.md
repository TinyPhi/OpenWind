# 2026-11-15 — Reporting audit hygiene and retention cap (#1139)

## Done

- **ADR-019 Stage 2 Criterion 11 — Redact SQL literals in audit logs**:
  - Implemented `redact_sql_literals()` and `compute_sql_hash()` in `docker/superset/superset_config.py` using tokenizing regex `_SQL_TOKEN_RE`. Replaces string/dollar literals with `'[REDACTED]'` and numeric literals (integers, floats, scientific, hex) with `[REDACTED]`, while preserving table/column identifiers, quoted identifiers, and SQL comments (`--`, `/* */`).
  - Extracted `build_reporting_audit_payload()` to module scope and wired it into `PlatformAuditEventLogger.build_audit_payload()`.
  - Added unit test suite `SqlLiteralRedaction` in `docker/superset/test_audit_mapping.py` covering email literals, numeric formats, hex, identifiers with digits, and comments.

- **ADR-019 Stage 2 Criterion 12 — Pseudonymise actor on user erasure**:
  - In `apps/api/src/services/user-erasure.ts`, added `pseudonymiseReportingAuditActor()` executed in a transaction switching to `tenant_purge_role`. Computed in TypeScript (`pseudonymiseActorId`, a truncated SHA-256 of the user id; replaced in review round 1 below). Sets `actor_id` on all `reporting.*` audit rows for that tenant, fulfilling GDPR erasure without relying on Art. 17(3)(b) for reporting security logs under legitimate interest.
  - Updated the reason text of the existing `admin_audit_log.actor_id` and `acting_person_id` entries in `USER_REFERENCE_COLUMNS_EXEMPT` (they were already exempt; no entry was added).
  - Added test case and seeded reporting rows in `apps/api/tests/isolation/user-erasure-anonymization.isolation.test.ts`.

- **ADR-019 Stage 2 Criterion 13 — Strip audit SQL text on tenant purge**:
  - In `packages/audit/src/index.ts`, updated `anonymizeAuditLogForTenant()` to strip the `sql` key from audit row `metadata` (`metadata = metadata - 'sql'`).
  - Added unit test in `packages/audit/src/index.test.ts` and seeded reporting query row in `apps/worker/tests/isolation/tenant-purge-audit-json.isolation.test.ts`.

- **ADR-019 Stage 2 Criterion 14 — Reporting audit retention cap**:
  - Added `REPORTING_AUDIT_RETENTION_DAYS` (default 90 days, positive integer; narrowed to 30–90 in review round 1 below) to `EnvSchema` in `packages/config/src/env.ts` and tested in `env.test.ts`.
  - Created migration `0164_reporting_audit_retention_role.sql` defining narrow role `reporting_audit_retention_role` (`NOLOGIN`, `NOBYPASSRLS`, granted to `app_user` `WITH INHERIT FALSE`). Row-level security policies limit `SELECT` and `DELETE` on `admin_audit_log` to rows where `action LIKE 'reporting.%'` (the age bound was added in review round 1 below).
  - Added `setReportingAuditRetentionRole()` in `packages/db/src/middleware.ts` and exported in `@platform/db`.
  - Implemented `apps/worker/src/reporting-audit-retention.ts` with atomic CTE batching (`WITH batch AS MATERIALIZED ... DELETE ... RETURNING 1`) and wired it into the daily worker retention sweep in `apps/worker/src/access-log-retention.ts`.
  - Added unit test `apps/worker/src/reporting-audit-retention.test.ts` and isolation test `apps/worker/tests/isolation/reporting-audit-retention.isolation.test.ts`.

## Review round 1 (2026-11-20, PR #1184)

- **M1 redaction escapes:** a backslash escapes a quote only in `E'...'` strings (Postgres `standard_conforming_strings = on`, the default), so `'C:\' OR email = '...'` no longer leaks the second literal. The scanner fails closed on unterminated strings, dollar-quotes, quoted identifiers and block comments, redacts PG16 underscore numerics (`1_000_000`, `0x_FF`), and leaves `$1` parameters alone. If a Superset database ever runs with `standard_conforming_strings = off`, a backslash can escape a quote in plain strings and this assumption would need revisiting.
- **M2 `sql_hash`:** now sha256 of the redacted, whitespace-normalised statement. Tenant purge still keeps it, since it carries no literal.
- **M3 comments:** line and block comment bodies become `-- [REDACTED]` / `/* [REDACTED] */` (block comments nest). The test that required PII in a comment to survive now asserts it is absent.
- **M4 pseudonym:** one random `pseudonym:<32 hex>` per erase, not derived from the user id. `actor_id` is overwritten only where it was the user's own (a `CASE`, as for `acting_person_id`). The dead `owsub:` arm was removed: `owsub:` is a Superset role-name prefix and is never stored in `actor_id`.
- **M5 retention floor:** migration 0164 (not yet on `main`, edited in place) bounds both role policies with `created_at < now() - interval '30 days'`; `REPORTING_AUDIT_RETENTION_DAYS` is validated to 30–90 (the 90 ceiling is the access-log sweep's own cap, which also settles G1).
- **Security review of the fixes (three more findings, all reproduced and fixed):**
  - The new 30-day bound did not hold when `app.tenant_id` was set before `SET ROLE`: `audit_log_tenant_isolation` (0011) is `FOR ALL` with no `TO` clause, so it applies to the role, and permissive policies are OR'd. Migration 0164 now adds a `RESTRICTIVE` policy carrying the bound; a new isolation test sets the tenant first and fails without it.
  - Dollar-quote tags may contain non-ASCII characters (`$é$ ... $é$` leaked); tags are now matched accordingly.
  - A string continued on the next line after an `E'...'` string stays in escape mode in Postgres (`E'x'` newline `'b\'` ...); the scanner now follows that, and redacts to the end if the continuation never closes.
  - Also redacted now: numbers followed by letters (`4111x`, a failed query is still audited) and a dollar-quote right after a number (`1$a$ ... $a$`). Trade-off: an identifier like `t1$x$` over-redacts the rest of the statement, which fails safe.
- **Known limits, not fixed here:** a SQL Lab user who sets `standard_conforming_strings = off` in the same script desynchronises the scanner (a backslash then escapes a quote in plain strings). Quoted-identifier bodies (`AS "jane@x.com"`) are kept by design.
- **Pre-existing, outside this PR (for a human decision):** `audit_log_tenant_isolation` casts `current_setting('app.tenant_id', true)::uuid` with no `NULLIF`. On a pooled connection that has run a tenant transaction the setting reads back as `''`, so any role-switched query (this role, `access_log_retention_role` from 0158, `tenant_purge_role`) that meets a row its own policy rejects throws `invalid input syntax for type uuid: ""`. It reproduces in one psql session with and without this PR's policy. Fixing it means changing a core RLS policy (ADR-001 territory).
- **Not done here (left for the PR thread):** G2 (isolate the two sweeps' failures), G3 (partial index for the retention batch), G4 (batch the `metadata - 'sql'` purge), S1–S4. S4: there are no Stage 2 deployments, so rows written before this change holding raw SQL age out in the 90-day sweep.

## Verification

- `docker/superset/test_audit_mapping.py`: 54/54 tests passed (including 10 literal redaction tests).
- `docker/superset/test_nullpool_guard.py`: 23/23 tests passed.
- `packages/config/src/env.test.ts`: 110/110 tests passed.
- `packages/audit/src/index.test.ts`: 13/13 tests passed.
- `packages/db/src/middleware.test.ts`: 7/7 tests passed.
- `apps/worker/src/reporting-audit-retention.test.ts`: 4/4 tests passed.
- `apps/worker/src/access-log-retention.test.ts`: 6/6 tests passed.

### After review round 1 (2026-11-20)

- `pnpm typecheck`: pass (52/52 tasks). `pnpm lint`: pass (52/52, `--max-warnings=0`). Both on Node 26.
- `pnpm test:isolation` (Node 26): pass. Worker 150/150; API 1180 passed, 9 skipped.
- `pnpm test` on Node 22, the version CI uses: pass (exit 0; admin-ui 1290/1290, worker 715/715, API 2760 passed, 9 skipped). On this machine's Node 26 the same suite shows 43 failures in four `admin-ui` files (`login`, `settings`, `language`, `platform-admin-mfa-session`): Node 25+ defines an experimental global `localStorage` that is `undefined` without `--localstorage-file` and shadows jsdom's. They pass 65/65 on Node 22, and `engines` says `>=22`, so making them robust on newer Node is a separate fix outside this PR. One earlier Node 26 run also had a 5 s timeout in `oncall-rotation-worker.isolation.test.ts`, which passes alone (22/22) and did not recur.
- `docker/superset/test_audit_mapping.py`: 69 tests pass, 8 skipped (they need Flask and Superset and run in the built image).
- The isolation suites ran on a fresh database with all 165 migrations applied. The local `platform_test` had only 107, so it could not exercise migration 0164.
- Negative checks: the new retention tests fail when the 30-day bound, or the restrictive policy, is removed from the database.
