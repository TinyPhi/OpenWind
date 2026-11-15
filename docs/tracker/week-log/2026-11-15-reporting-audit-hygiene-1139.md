# 2026-11-15 — Reporting audit hygiene and retention cap (#1139)

## Done

- **ADR-019 Stage 2 Criterion 11 — Redact SQL literals in audit logs**:
  - Implemented `redact_sql_literals()` and `compute_sql_hash()` in `docker/superset/superset_config.py` using tokenizing regex `_SQL_TOKEN_RE`. Replaces string/dollar literals with `'[REDACTED]'` and numeric literals (integers, floats, scientific, hex) with `[REDACTED]`, while preserving table/column identifiers, quoted identifiers, and SQL comments (`--`, `/* */`).
  - Extracted `build_reporting_audit_payload()` to module scope and wired it into `PlatformAuditEventLogger.build_audit_payload()`.
  - Added unit test suite `SqlLiteralRedaction` in `docker/superset/test_audit_mapping.py` covering email literals, numeric formats, negative numbers, hex, identifiers with digits, and comments.

- **ADR-019 Stage 2 Criterion 12 — Pseudonymise actor on user erasure**:
  - In `apps/api/src/services/user-erasure.ts`, added `pseudonymiseReportingAuditActor()` executed in a transaction switching to `tenant_purge_role`. Sets `actor_id = 'pseudonym:' || encode(digest(target_user_id, 'sha256'), 'hex')[1..16]` on all `reporting.*` audit rows for that tenant, fulfilling GDPR erasure without relying on Art. 17(3)(b) for reporting security logs under legitimate interest.
  - Added `admin_audit_log.actor_id` to `USER_REFERENCE_COLUMNS_EXEMPT`.
  - Added test case and seeded reporting rows in `apps/api/tests/isolation/user-erasure-anonymization.isolation.test.ts`.

- **ADR-019 Stage 2 Criterion 13 — Strip audit SQL text on tenant purge**:
  - In `packages/audit/src/index.ts`, updated `anonymizeAuditLogForTenant()` to strip the `sql` key from audit row `metadata` (`metadata = metadata - 'sql'`).
  - Added unit test in `packages/audit/src/index.test.ts` and seeded reporting query row in `apps/worker/tests/isolation/tenant-purge-audit-json.isolation.test.ts`.

- **ADR-019 Stage 2 Criterion 14 — Reporting audit retention cap**:
  - Added `REPORTING_AUDIT_RETENTION_DAYS` (default 90 days, positive integer) to `EnvSchema` in `packages/config/src/env.ts` and tested in `env.test.ts`.
  - Created migration `0164_reporting_audit_retention_role.sql` defining narrow role `reporting_audit_retention_role` (`NOLOGIN`, `NOBYPASSRLS`, granted to `app_user` `WITH INHERIT FALSE`). Row-level security policies strictly limit `SELECT` and `DELETE` on `admin_audit_log` to rows where `action LIKE 'reporting.%'`.
  - Added `setReportingAuditRetentionRole()` in `packages/db/src/middleware.ts` and exported in `@platform/db`.
  - Implemented `apps/worker/src/reporting-audit-retention.ts` with atomic CTE batching (`WITH batch AS MATERIALIZED ... DELETE ... RETURNING 1`) and wired it into the daily worker retention sweep in `apps/worker/src/access-log-retention.ts`.
  - Added unit test `apps/worker/src/reporting-audit-retention.test.ts` and isolation test `apps/worker/tests/isolation/reporting-audit-retention.isolation.test.ts`.

## Verification

- `docker/superset/test_audit_mapping.py`: 54/54 tests passed (including 10 literal redaction tests).
- `docker/superset/test_nullpool_guard.py`: 23/23 tests passed.
- `packages/config/src/env.test.ts`: 110/110 tests passed.
- `packages/audit/src/index.test.ts`: 13/13 tests passed.
- `packages/db/src/middleware.test.ts`: 7/7 tests passed.
- `apps/worker/src/reporting-audit-retention.test.ts`: 4/4 tests passed.
- `apps/worker/src/access-log-retention.test.ts`: 6/6 tests passed.
