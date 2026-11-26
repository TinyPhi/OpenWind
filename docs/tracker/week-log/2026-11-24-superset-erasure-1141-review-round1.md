# 2026-11-24 — Superset erasure completion target (#1141): review round 1 on #1182

Answers PrabhuVijit's review of head `d8307c76` (M1–M3, G1–G5, S1–S6, test coverage) and merges
`main` (#1183) into the branch.

## Done

- **M1** The 7-day age no longer comes from Prometheus `for:` uptime. Each entry carries the audit
  row's `created_at`; `openwind_superset_erasure_unreconciled_age_seconds` is `now - created_at`
  at scrape time. `SupersetErasurePending7d` / `SupersetErasurePending25d` use a 15m `for:` to
  debounce only. The sweep reads `ORDER BY created_at` so the oldest rows are inside the batch
  limit, and a tenant whose sweep failed keeps its previous entries.
- **M2** The lookback is 90 days (`MONITOR_WINDOW_DAYS`), so an erasure that missed day 30 stays
  listed and retried. `SupersetErasurePending25d` is critical and keeps firing past day 30.
- **M3** A terminally failed row stays in the gauges and is not re-enqueued.
- **G1** The count gauge is one unlabelled series again; per-erasure series moved to the age gauge.
- **G2** A later `superset_erasure.completed` tenant row closes that tenant's earlier user rows.
- **G3** Tenant purge rows have no Stage 2 marker: documented as an intended, idempotent backfill.
- **G4** The Redis payload is checked with a type guard (`@platform/redis` has no Zod dependency).
- **G5** Runbook restructured: the target section moved out of the middle of the numbered
  procedure, stale statements corrected. Worker header comment rewritten.
- **S1–S5** Day-25 critical alert; privacy wording (the hash is pseudonymous, held in Prometheus
  and Alertmanager); label cardinality capped at the oldest 100; one atomic writer
  (`writeSupersetUnreconciled`, `MULTI`) and the dead count writer removed; duplicates removed.
- **S6** `main` merged first (#1183), conflicts in `CHANGELOG.md` and the runbook only.

## Review of this round's own diff

- A medium `/review` of the staged diff raised four points. Accepted: terminally failed rows could
  fill the 500-row batch and starve retryable rows (now read apart, each with its own limit); the
  failed-tenant carry-forward could undercount, or reset alerts without a snapshot (count floor,
  and nothing is published when there is no snapshot to carry); a code comment overstated a bound.
  Documented as a limit, not changed: an entry pushed out of the 100-entry list, or older than
  the 90-day window, is zero-filled although it may still be open.

## Found while fixing

- The OTel SDK in use (`sdk-metrics` 2.10, Prometheus exporter, cumulative) keeps a gauge series
  at its last observed value after the callback stops observing it, so the review's "the series
  goes stale after completion" does not hold: the labelled series would have stayed at its last
  value and an alert on it could never have cleared. The age gauge reports a departed entry once
  as `0`. Reproduced with a minimal script and covered in `metrics-superset-erasure.test.ts`.
- A drizzle column interpolated into a select-list subquery renders without its table, so a
  `terminalFailed` EXISTS matched any failed row of the tenant. Caught by the new Postgres test;
  the correlated columns are now qualified.
- `superset_erasure.failed` rows are written with `{kind, attempts}` and no `status`, so in
  practice every failed row is terminal; the `unverified` branch has no writer.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:isolation`: see the PR.
- `pnpm test:alerts` (promtool check and test): pass, 19 rules.
- New: `apps/worker/tests/isolation/superset-erasure-reconcile.isolation.test.ts` (real Postgres:
  window, ordering, sibling rules, terminal failure, tenant completion, RLS),
  `packages/telemetry/src/metrics-superset-erasure.test.ts`, extended redis and worker unit tests.

## Open

- A per-erasure series that has been reported stays in the exporter (at `0`) until the process
  restarts. The set is bounded by erasures that were open for over an hour in that process.
