# 2026-10-20 — purge retry finishes the cleanup outside the database (#1050)

- The post-commit steps (delete the tenant's files, delete the sandbox handover credentials in Redis, queue the
  Superset cache flush) are one helper, `cleanUpOutsideDatabase`, used after the purge and now also when a job
  finds the tenant already `purged`. Before, a crash after the status flip left the files and the handover key
  behind, because the retry returned early.
- All three steps are idempotent and best-effort (errors are logged, never thrown), so running them twice is
  safe and a failure still does not fail the job.
- Not changed: the DB purge itself is not redone for a purged tenant, and no completion audit entry is written
  twice. Tests (unit, mocked boundaries): the cleanup runs for a purged tenant, survives a file-deletion error,
  skips the DB work, and does nothing for any other status; the first and third fail without the change.
