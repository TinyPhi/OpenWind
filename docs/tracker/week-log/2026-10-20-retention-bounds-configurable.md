# 2026-10-20 — #637 follow-up: retention bounds and the shorten confirmation are configurable

- New validated env vars with the old fixed values as defaults: `RETENTION_DAYS_MIN`/`MAX`,
  `RETENTION_COMMENT_DAYS_MIN`/`MAX`, `RETENTION_EVIDENCE_DAYS_MIN`/`MAX`, and
  `RETENTION_REQUIRE_SHORTEN_CONFIRM`. `RETENTION_BOUNDS` (used by provisioning, the PATCH and the worker's
  shared policy function) is built from them. Startup refuses a minimum above its maximum, a platform default
  outside its range, and a bound under 1 day or over 100 years.
- The confirmation requirement turns off only for the literal `false`, so a typo keeps the safe behaviour.
- New real-database test: five concurrent updates to one tenant (four retention fields and a rate-limit write)
  all survive. Removing the `FOR UPDATE` makes it fail every time, so it proves the lock.
- Left as in #1036: the refusal is still a 400 (a 422 would also fit), and a hold-only change needs no
  confirmation.
