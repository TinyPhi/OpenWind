# Implementation Plan: Postgres Pool Load-Test Tooling

**Spec:** docs/specs/pool-load-test-tooling.md
**Generated:** 2026-08-25
**Status:** T1/T2/T3 done; T4/T5 deferred (pending real run)

---

## Phase 1 — k6 script + run instructions

**Goal:** a runnable, parameterized k6 script exists and can be pointed at the live stack.
**Gate:** script runs against a live `docker compose` stack and prints p50/p95 latency → then Phase 2

| task                                                                                                                                                            | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: write `scripts/load-test/pool-ceiling.js` — parameterized tenant count / req-s-per-tenant / duration, distinct auth token per simulated tenant              | R1          | done   |
| T2: write `scripts/load-test/README.md` — run command via `grafana/k6` Docker image, `pg_stat_activity` capture command, PgBouncer `SHOW POOLS` capture command | R1, R2      | done   |

---

## Phase 2 — Worker-contention scenario, one real run, results doc

**Goal:** exercise both API and worker pool contention together, run it once, write down what happened.
**Gate:** §R acceptance criteria met — Phase 1 gate still green

| task                                                                                                                                                    | requirement | status   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| T3: write the synthetic-backlog helper for `outbox_events` (or equivalent poller-backed table)                                                          | R3          | done     |
| T4: run the full scenario once against the live dev stack at the 20×5/5min provisional target, with backlog injected; capture connection + latency data | R1, R2, R3  | deferred |
| T5: write `docs/sup-docs/load-test-results/2026-08-25-pool-ceiling-baseline.md` from the T4 run, provisional/dev-scale caveats stated up front          | R4          | deferred |

---

## Kick-Off Prompt

Read docs/specs/pool-load-test-tooling.md and docs/specs/pool-load-test-tooling-tasks.md.

Implement Phase 1 tasks only (T1, T2).

Rules:

- Do not begin Phase 2 until Phase 1's gate is green (script runs against the live stack and prints latency numbers).
- After each task, verify and confirm before continuing.
- If a decision isn't covered by the spec, stop and ask — do not assume.
- If something fails, log it via `/spec amend §B` before fixing.
- If a bug class could recur, promote it to `/spec amend §V`.
