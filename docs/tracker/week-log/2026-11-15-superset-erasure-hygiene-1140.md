# 2026-11-15 — Superset erasure hygiene checks (#1140)

## Context

ADR-019 Stage 2 gate criteria 15 and 16 and the process-log and export-file confirmations need evidence. The first round
(2026-11-15) lowered a constant and wrote the attestations; the review of 2026-11-20 found several of them were not true.
This entry records what the code and runbook now say.

## Done

- **Failed jobs are removed on a schedule (criterion 15).** BullMQ's `removeOnFail.age` is lazy: in the installed
  `bullmq@5.76.8` it trims old failed jobs only when another job in the same queue moves to `failed`, so a failure that
  nothing follows keeps its `{kind, tenantId, subject}` payload in Redis indefinitely. `cleanSupersetErasureFailedJobs`
  (`apps/worker/src/superset-erasure-failed-cleanup.ts`) calls `queue.clean(24 h, 1000, "failed")`, which ages a failed job
  by `finishedOn`, and the reconcile sweep runs it every 5 minutes before its mode check, so it applies in any erasure
  mode. `removeOnFail` stays at 24 hours in both queue configurations as a second line.
- **Completed jobs too.** The same sweep removes completed jobs one hour after they completed: a completed job's payload names the person as well, and `removeOnComplete.age` is just as lazy.
- **Process logs (the attestation was wrong).** The review showed that gunicorn's default access log writes the whole
  request line including the query string, a failed audit write logged a SQLAlchemy error whose text carries the bound
  parameters (the audit row's JSON, whose `sql` field is the user's query), sign-in warnings logged `preferred_username`,
  and no log retention was set. Now:
  - both compose files set `GUNICORN_CMD_ARGS="--access-logformat '%(m)s %(U)s %(s)s %(D)s'"` (method, path, status,
    duration; no query string, client address or referer). Upstream `run-server.sh` at 6.1.0 passes only `--access-logfile`,
    so the setting is not overridden. The prod file replaces `environment` with `!override`, so it has its own copy;
  - the `superset` service rotates container logs by size (`json-file`, `max-size: 10m`, `max-file: 5`), inherited by the
    prod file. That bounds volume, not age, and the runbook says so;
  - `log_audit_write_failure` logs the action and the exception type only;
  - the sign-in warnings log the opaque Zitadel subject id instead of `preferred_username`, and the per-query "no tenant"
    line logs no identity. The subject id stays in the logs as residual pseudonymous data, which the runbook states.
  - every failure log in `superset_config.py` is type-only (`log_error_type`): the erasure endpoint, the user lookup and the
    tenant lookup used `logger.exception` or `exc_info`, and a SQLAlchemy error carries the bound parameters, including the
    `owsub:<subject>` of an erase. A test forbids `logger.exception` and `exc_info` there;
  - Flask-AppBuilder 5.0.2 logs the whole `userinfo` dict, the username, an email and a failed `add_user`'s exception text at
    ERROR (`security/manager.py:1405,1441`, `security/sqla/manager.py:218,228,276`), which `SILENCE_FAB` does not hide.
    `_ScrubFabSecurityLogs` on those two loggers keeps each message and replaces its values with `[REDACTED]`. It is tested on
    synthetic records; that Superset's logging setup leaves it in place is **not yet confirmed** on a running instance.
- **Runbook (`docs/runbooks/superset-erasure.md`).** Failed-job recovery points at the audit log, which outlasts the queue
  (a "resolved" alert does not mean the person was erased) and states the dependency on #1182 for tenant rows. The criterion
  16 list is rebuilt from the code with a `file:line` per path: it adds the sandbox provisioning rollback and the 30-day
  delay before a deleted tenant's accounts are purged, corrects the per-user path (it calls `eraseUserInSuperset`, and a
  non-member only gets the cache flush) and the org-directory source (Zitadel metadata). The process-log and export-file
  sections separate what is confirmed from code and config from what is **NOT YET CONFIRMED** on a running instance, with the
  commands for the gate owner.
- **ADR-019 edit reverted.** This PR had rewritten an Accepted ADR before gate sign-off with no evidence link. ADRs are
  human-authored, so the file is back to `main`'s text and the gate owner amends it at sign-off with the evidence.
- **Alert.** The `SupersetErasureJobFailedInQueue` comment describes the real removal, and a promtool case shows it resolving
  once the failed job is gone.

## Tests

- `apps/worker/tests/isolation/superset-erasure-failed-cleanup.isolation.test.ts`, real Redis and real BullMQ: a job with
  `removeOnFail: { age: 1 }` and a failure older than 24 hours is still there with its payload when nothing else fails (the
  premise); the cleanup removes it, payload included; a job that failed inside the retention stays and goes once older; a job
  created long ago that failed just now is kept (age is `finishedOn`, not creation).
- `docker/superset/test_log_hygiene.py` (runs in the built-image harness too): the audit-failure log has no SQL, parameters or
  traceback; every failure log is type-only with the place it was raised; no `logger` call names a login name or email or
  writes a traceback (checked on the syntax tree); Flask-AppBuilder's sign-in errors keep their message and lose their values.
  Seven of its eight tests fail against `main`'s config.
- `apps/worker/src/superset-compose-logging.test.ts`: both compose files keep the log rotation and the path-only access-log
  format (three of its four tests fail against `main`'s compose files). This is a vitest, not a Python test, because the
  built-image harness mounts only `docker/superset` and CI's host Python step runs a single file.
- `docker/superset/test_sqllab_identity.py`: the #806 test that asserted a logged traceback now asserts the exception type and
  location and the absence of its text. It needs Flask and Superset, so it only runs in CI's built image; the first push of this
  PR failed there on that test and on the compose tests reading files the harness cannot see, both fixed.
- `apps/worker/src/superset-erasure-removal-paths.test.ts`: a best-effort tripwire on the files that mention `deleteUser`,
  `deleteOrg` or delete `tenant_users`. It matches the identifier, so an aliased import, a method call, a function reference and a
  re-export all fail it (each verified); it does not track a new wrapper in an already-listed file.
- `superset-erasure-options.test.ts` pins the 24-hour and 1-hour constants. The Redis test also covers completed jobs: a
  completed job past its hour is removed, one inside it stays.

## Not done / follow-ups

- The runbook's criterion 16 list gains two honest gaps: a platform admin's Superset account is **not yet confirmed** (`PLATFORM_ORG_ID` is a `tenants.id`, so whether such an account exists depends on the platform tenant's Zitadel org), and a user removed directly in the Zitadel console is **not covered**: nothing reacts to it, so their Superset account stays until erased by hand.
- Nothing here was confirmed on a running Superset instance; the runbook lists the commands. The gunicorn setting and the
  Docker rotation are validated by config tests and `docker compose config`, not by running the image.
- Superset, Flask, SQLAlchemy and gunicorn messages from their own code are not controlled by this change.
- #1182 extends the reconcile sweep to tenant purge rows; until it lands, a stalled tenant erasure is found from the audit
  rows by hand. Both PRs edit the same runbook lines and CHANGELOG, so #1182 follows this one.
- `reporting-audit-retention.isolation.test.ts` (from #1184) can lose its 95-day-old non-reporting row when the real
  access-log sweep in a parallel file runs, which deletes every audit row older than 90 days. It passes alone and on rerun.
  Noted for #1190.

## Verification

Databases migrated through the runner, Node 26, on the final code:

- `prettier --check` over the repo, `pnpm typecheck` and `pnpm lint` (worker and API): pass.
- `python3 -m unittest discover` in `docker/superset`: 211 tests, all passing, 116 skipped because they need Flask and Superset
  (they run in CI's built image).
- `promtool test rules` and `promtool check rules` (17 rules): pass. `docker compose config` validates the dev file and the
  merged prod file.
- Worker unit 728/728, worker isolation 156/156 (including the real-Redis cleanup test), API options test pass; API isolation
  1180 passed (9 skipped) on a fresh database.
- Seen once in earlier runs and not reproduced: the on-call rotation 5 s timeout under parallel load (passes alone), a
  leftover-row collision in `user-erasure-anonymization` on a database reused across several full runs (passes on a fresh one),
  and the `reporting-audit-retention` test above, which loses its old non-reporting row when the real access-log sweep in a
  parallel file runs (passes alone and on rerun).
