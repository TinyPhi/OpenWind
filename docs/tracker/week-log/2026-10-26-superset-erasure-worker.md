# 2026-10-26 — #728 slice 3: Superset erasure runs automatically, retries, and is audited

- Worker queue `superset-erasure`: after `DELETE /users/:userId` commits and after a tenant purge, a job
  logs in to Superset as the service account and calls `/openwind/erasure/{user,tenant}` until it reports it
  has finished. 32 attempts, 1 minute doubling up to 1 hour (custom backoff: BullMQ's own has no cap), about
  26 hours in all. Only when Stage 2 is on; with it off the existing cache flush is all that runs.
- Audit: migration `0156` adds `superset_erasure.completed` / `.failed`. Both are written as the system with
  the same tenant, resourceType and resourceId as the platform's `deleted` / `purge.completed` row, counts only;
  `failed` once, on the last attempt. The admin who asked is recorded once, on the platform row.
- The job keeps Superset's counts, so a retry after a failed audit write does not record zeros.
- `SupersetErasureFailed` alert (promtool-tested) and `docs/runbooks/superset-erasure.md`. The alert fires when
  a job spends its last retry (about 26 h), earlier than the spec's 7 days. The counter starts at 0 for both
  outcomes: without that, the first failure of a process reads as no increase and never fires.
  `SupersetErasureJobFailedInQueue` is the backstop: `superset-erasure` is added to the queues whose depth is
  exported, and any job in its failed state (kept 7 days) raises the alert, including a job BullMQ failed after it
  stalled twice, which writes no audit row.
- A second erase of the same user or tenant replaces a failed or finished job with the same id (BullMQ ignores an
  add whose id exists); the user job id is built from the hashed subject because BullMQ ids cannot contain a colon.
- Local run of the real worker against the local Superset 6.1.0 (isolated Redis db, a copy of the platform DB with
  0156 applied, stand-in Superset users with queries, saved queries, logs and a favourite): the normal path erased
  18 rows and wrote one `completed` row whose resource id equals the platform's; with Superset unreachable the
  first attempt failed, the job waited its 60 s, and attempt 2 completed; with it never reachable, two attempts
  ended in exactly one `failed` row. Other Superset users were unchanged. Run before the migration was applied,
  the audit insert was refused and the job kept its result for the retry.
- Not done here: the production OpenBao keys the API and worker need when Stage 2 is on (runbook, "Production
  setup"), the name/email refresh at login (T15), and running the real-database tests in CI (H4).
