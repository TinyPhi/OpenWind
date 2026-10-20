# 2026-10-20 — #728 slice 1: flush Superset's result cache on erasure and tenant purge

- New optional `SUPERSET_REDIS_URL` (the Redis db Superset caches in; compose sets `redis://redis:6379/2`
  for the backend and worker, prod allowlist updated). Unset, the feature is off.
- Worker queue `superset-cache-flush` (8 attempts, 60 s exponential back-off) scans and unlinks the
  `superset_` and `superset_data_` prefixes in that db only. Cached keys are opaque hashes, so the flush
  clears every tenant's cached results; the cost is a re-query.
- Queued after `DELETE /users/:userId` commits and after a tenant purge; one job per 10 s window; a
  failed enqueue is logged and never fails the erasure or the purge.
- Tested against real Redis (two spare dbs: the Superset prefixes go, other prefixes and another db's
  Superset-prefixed keys stay, 1,500 keys cleared in one call).
- Deliberately not the spec's endpoint design for this slice (see the deviation note in
  `superset-gdpr-erasure-tasks.md`). Superset DB erasure, the audit actions and Stage 2 config are still open.
- Local note: one run of the full API isolation suite failed
  `automation-transition-dedup-concurrent-lock`, which passes alone with and without this change.
