# Postgres Pool Load-Test Tooling

> Build the k6 script + instrumentation needed to answer #296 ("is DATABASE_POOL_MAX=10 enough?") — not the sizing decision itself, which needs a real target number and a production-like run.

status: draft
created: 2026-08-25
updated: 2026-08-25

---

## §G Goal

- A runnable k6 script exists that drives concurrent-tenant API load against the
  `docker compose` stack and reports p50/p95 latency.
- Connection-pool saturation on both the app side (`DATABASE_POOL_MAX`) and PgBouncer
  side (`DEFAULT_POOL_SIZE`) is observable during a run, not just inferred after the fact.
- A worker-poller backlog scenario can run concurrently with API load, since `ow-worker`
  and `ow-backend` compete for the same PgBouncer pool budget.
- One results doc exists from an actual run against the provisional target, so the next
  person doesn't start from zero — but it is explicitly labeled non-authoritative pending
  a real product concurrency number and a production-like data volume.

## §C Constraints

| constraint          | value                                                                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack               | `docker compose up -d` (full stack, or at minimum `postgres`, `pgbouncer`, `ow-backend`, `ow-worker`, `redis`)                                                                                                  |
| tool                | `k6` via the `grafana/k6` Docker image — no new pnpm devDep, keeps this out of the JS toolchain/lockfile entirely                                                                                               |
| current pool config | `DATABASE_POOL_MAX=10` (packages/config/src/env.ts) per process; `ow-backend` and `ow-worker` each open their own pool, both against PgBouncer's `DEFAULT_POOL_SIZE=20`; Postgres `max_connections=200`         |
| provisional target  | **20 concurrent tenants × 5 req/s/tenant, sustained 5 min — explicitly a placeholder**, not a product requirement. Must be visually flagged as provisional everywhere it appears (script comments, results doc) |
| auth                | k6 needs valid JWTs to hit authenticated routes — reuse this repo's existing test/seed users rather than inventing new auth plumbing                                                                            |
| out of scope        | picking a final production `DATABASE_POOL_MAX`/`DEFAULT_POOL_SIZE` value; a production-like data-volume run; CI integration (this is a manual/on-demand tool, not a gate)                                       |

## §I Interfaces

- `scripts/load-test/pool-ceiling.js` (new) — k6 script.
- `scripts/load-test/README.md` (new) — how to run it, what it measures, how to read `SHOW POOLS` / `pg_stat_activity` output.
- `docs/sup-docs/load-test-results/2026-08-25-pool-ceiling-baseline.md` (new) — one results doc from the first real run.

## §R Requirements

R1: A k6 script simulates concurrent-tenant load against the live API
✓ script is parameterized (env vars or k6 `--env`) for tenant count, req/s/tenant, and duration — the provisional 20×5/5min target is the default, not hardcoded
✓ running `docker run --rm -v $(pwd)/scripts/load-test:/scripts grafana/k6 run /scripts/pool-ceiling.js` against a live stack completes and prints p50/p95 latency
✓ each simulated "tenant" uses a distinct auth token / tenant context, not one shared connection identity, so the test actually exercises per-tenant RLS query paths

R2: Connection-pool state is observable during the run, not just inferred afterward
✓ a documented command captures `pg_stat_activity` count (grouped by application_name/state) at intervals during the run
✓ a documented command captures PgBouncer's `SHOW POOLS` output at intervals during the run
✓ the README states which of the two metrics (app-side pool vs PgBouncer pool) hits its ceiling first, for the one run actually performed

R3: A worker-poller backlog scenario runs alongside API load
✓ a documented method exists to insert N synthetic backlog rows into `outbox_events` (or another poller-backed table) before/during the k6 run
✓ the results doc records whether pool contention from worker pollers measurably degrades API latency during the same run, or vice versa

R4: A results doc exists from one real run against the provisional target
✓ `docs/sup-docs/load-test-results/2026-08-25-pool-ceiling-baseline.md` records: p50/p95 API latency, max observed connections per process, whether `DATABASE_POOL_MAX`/`DEFAULT_POOL_SIZE` saturated before Postgres's `max_connections`, and the exact load profile used
✓ the doc states in its first paragraph that the target (20×5/5min) is provisional and the run used dev-scale data, not production data — so it cannot be read as a sizing recommendation
✓ the doc explicitly lists what would need to change for a production-grade sizing exercise (real concurrency number, production-representative data volume, running outside a laptop/dev-scale environment)

## §V Invariants

- Any pool-sizing claim in this repo must cite the load profile and data volume it was measured under — a bare number ("pool size should be 25") without that context is not trustworthy and should not be committed.
- Load-test tooling lives outside the pnpm workspace/lockfile (k6 via Docker image, not an npm package) so it never becomes a dependency-bump or CI surface by accident.
- k6 scripts in this repo must explicitly set `summaryTrendStats` to include every percentile `handleSummary` reads — the default stat set omits `p(50)`, and reading a stat that wasn't requested crashes the summary with an unhelpful `toFixed` error.

## §T Tasks

| id  | task                                                                                                                                                | phase | status   | depends  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- | -------- |
| T1  | write `scripts/load-test/pool-ceiling.js` (k6 script, parameterized tenant/rps/duration)                                                            | 1     | done     | —        |
| T2  | write `scripts/load-test/README.md` — run instructions, `pg_stat_activity`/`SHOW POOLS` capture commands                                            | 1     | done     | T1       |
| T3  | write the synthetic-backlog helper (SQL or small script) for the worker-contention scenario                                                         | 2     | done     | T1       |
| T4  | run once against the live dev stack at the provisional target; capture connection/latency data                                                      | 2     | deferred | T1,T2,T3 |
| T5  | write `docs/sup-docs/load-test-results/2026-08-25-pool-ceiling-baseline.md` from the T4 run, with the provisional/dev-scale caveats stated up front | 2     | deferred | T4       |

phase gate: T4's run must actually complete without the k6 script itself erroring out before T5 is written — a results doc from a broken run is worse than no doc

## §B Bugs / Backprop Log

| id  | what failed                                                                                             | root cause                                                                                                                                                                                                                                                                                                                                                                                                                              | promoted to §V?                                 |
| --- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| B1  | AC1's "distinct auth token per simulated tenant" isn't cheaply achievable                               | dev stack forces every valid JWT's tenantId to `env.DEV_TENANT_ID` regardless of signing org (`packages/auth/src/jwks.ts`, `NODE_ENV !== "production"`); no per-request tenant override exists. Real per-tenant tokens would need new multi-org Zitadel provisioning — out of scope for load-test tooling. Resolved: one shared token, N concurrent virtual users (human-approved scope call) — documented as a limitation in README.md | no — scoped decision, not a recurring bug class |
| B2  | `handleSummary` crashed with `Cannot read property 'toFixed' of undefined` on first live smoke-test run | k6's default `summaryTrendStats` is `['avg','min','med','max','p(90)','p(95)']` — `p(50)` is not computed unless explicitly requested. Fixed by adding `p(50)` to `options.summaryTrendStats`                                                                                                                                                                                                                                           | yes — see §V                                    |
| B3  | Full authenticated end-to-end run (T4) not performed this session                                       | would require bootstrapping a real Zitadel instance via `./setup.sh` (new sibling `../zitadel/` project, containers, generated credentials) — a heavier one-time setup step than this task's scope; human chose a lighter smoke-test verification instead (unauthenticated 401 + k6 mechanics against `/health`), confirmed working. T4/T5 deferred to whoever runs the real load test                                                  | no — deferred by explicit choice, not a defect  |

---

_spec is source of truth — update as decisions are made_
