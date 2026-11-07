# 2026-11-05 — Superset Python tests in CI (#1143, phase 1)

Workflow edited by a human (workflow files are off-limits to agents); the agent proposed the job and reviewed the result.

## Done

- `superset-guard` now discovers every `docker/superset/test_*.py` in the built image instead of only `test_nullpool_guard.py`. The Flask-only tests (ST17, audit mapping and scope, erasure endpoint, SQL Lab identity) run for the first time; real-database tests still skip here because no database environment is set.
- New advisory job `superset-erasure-realdb` (`continue-on-error`, not in `ci-complete`): Postgres and Redis services, `superset db upgrade` against a throwaway database, then `test_erasure_*.py`. The job fails if any test was skipped, so a missing database environment cannot pass silently (stopgap until a `REQUIRE_REALDB` opt-in exists in the tests).

## Open

- Phase 2: add the job to `ci-complete` `needs` and its result check after a week green. Phase 3: ST17, audit and SQL Lab real-database tests.
- The widened discovery is in a required job: a rotted Flask-only test now fails `superset-guard`.
- `superset db upgrade` against a fresh database is unconfirmed; the first run may show config or env needs.
