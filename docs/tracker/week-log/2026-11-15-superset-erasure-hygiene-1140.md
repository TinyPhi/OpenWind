# 2026-11-15 — Superset erasure hygiene checks (#1140)

## Done

- `apps/worker/src/superset-erasure-options.ts` & `apps/api/src/lib/superset-erasure-options.ts`: bounded failed-job retention in Redis (`removeOnFail`) from 7 days (604,800s) to 24 hours (`age: 86_400`), fulfilling ADR-019 Stage 2 gate criterion 15.
- `apps/worker/src/superset-erasure-options.test.ts` & `apps/api/src/lib/superset-erasure-options.test.ts`: updated test assertions to verify 24-hour failed-job retention.
- `docker/observability/alert.rules.yml`: updated `SupersetErasureJobFailedInQueue` comment reflecting 24-hour job retention.
- `docs/decisions/ADR-019-reporting-tenant-isolation.md`: updated the "Negative and mitigations" bullet regarding external tenant data to confirm export files do not persist on disk (streaming HTTP CSV responses, no Celery, no `RESULTS_BACKEND`).
- `docs/runbooks/superset-erasure.md`:
  - Added full enumeration of all user-removal paths (per-user erase, tenant purge, sandbox delete, sandbox reset, sandbox handover, org-directory sync, platform admin) and documented Superset erasure coverage (ADR-019 criterion 16).
  - Documented Superset process logging (stdout/stderr log retention, confirmation that verbatim SQL and emails are not logged).
  - Documented confirmation that export files do not persist on disk.
  - Updated failed job queue retention window from 7 days to 24 hours.

## Verification

- `(cd apps/worker && ./node_modules/.bin/vitest run src/superset-erasure-options.test.ts)`: passed (3 tests).
- `(cd apps/api && ./node_modules/.bin/vitest run src/lib/superset-erasure-options.test.ts)`: passed (1 test).
- `docker run ... promtool check rules /r/alert.rules.yml` and `promtool test rules /r/alert.rules.test.yml`: passed (17 rules found, all unit tests passed).
- Linting and typechecking passed with 0 errors.
