# Advisory Lock Direct Connection

> Make `acquireTenantAdvisoryLock` actually exclude concurrent holders behind PgBouncer transaction
> pooling, by taking session locks on a direct Postgres connection. For anything that guards a
> multi-step operation (org-directory sync, sandbox reset/delete). Fixes #752.

status: approved
created: 2026-10-09
updated: 2026-10-09

---

## §G Goal

- Two callers can never both hold the same `(namespace, tenantId)` lock in the compose/prod topology.
- A misconfigured topology is loud, not silent.
- No behaviour change for CI, host-mode dev, or any deployment that does not opt in.

## §C Constraints

| constraint      | value                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| evidence        | repro 2026-10-09 against the local stack: via PgBouncer :6432 (transaction mode) 40/40 iterations double-granted the same key (both reserved connections landed on one backend; advisory locks are re-entrant per session); direct :5432 0/40                                                                                                            |
| callers         | `packages/org-directory/src/sync.ts`, `apps/worker/src/sandbox-reset-worker.ts`, `apps/api/src/routes/platform-admin/sandbox-reset.ts` (pre-check); #838's delete will add one                                                                                                                                                                           |
| lock kind       | stays a session-scoped `pg_try_advisory_lock`: it must survive an external network call between DB operations (org-directory `fetchAll`) and release on holder crash. Transaction-scoped locks and lease rows are rejected (see client.ts history: a row-based lock was replaced after a security review found stale-reclaim could steal a healthy lock) |
| connection      | new optional `DATABASE_DIRECT_URL` (`@platform/config`), `app_user` role, direct to Postgres (not PgBouncer). Unset => reuse the existing client (today's behaviour). Not `MIGRATION_DATABASE_URL` (privileged role)                                                                                                                                     |
| lock pool       | dedicated client, lazily created, `max` = `DATABASE_LOCK_POOL_MAX` (default 5); each held lock pins one connection, so the pool caps concurrent holders. These connections bypass PgBouncer's cap: each process can open up to that many direct backends, so replicas multiply it and Postgres `max_connections` (200 in compose) must cover them        |
| bounded wait    | on the dedicated direct pool only, `reserve()` waits at most 5 s for a slot, then rejects with a typed error; a connection that arrives late is released, never leaked. With `DATABASE_DIRECT_URL` unset the shared main client keeps queueing exactly as before (default behaviour unchanged, R3)                                                       |
| signature       | `acquireTenantAdvisoryLock(tenantId, namespace)` and `TenantAdvisoryLock` unchanged; no caller edits                                                                                                                                                                                                                                                     |
| schema          | none                                                                                                                                                                                                                                                                                                                                                     |
| dependency rule | `@platform/db` stays on `config` + `logger` only: no telemetry import (new edge). Anomalies are structured error logs; a counter is deferred                                                                                                                                                                                                             |
| CI              | test jobs connect straight to Postgres and `.github/workflows` is off-limits, so CI cannot exercise PgBouncer; the PgBouncer test is opt-in and run locally                                                                                                                                                                                              |
| out of scope    | changing PgBouncer pool mode; a second PgBouncer; replacing session locks with lease rows; automation-engine's `pg_advisory_xact_lock` (already correct); the lock-pool counter metric                                                                                                                                                                   |

## §I Interfaces

**Config** (`packages/config/src/env.ts`)

| var                      | default | notes                                   |
| ------------------------ | ------- | --------------------------------------- |
| `DATABASE_DIRECT_URL`    | unset   | URL; unset => lock uses the main client |
| `DATABASE_LOCK_POOL_MAX` | 5       | int >= 1                                |

**Wiring**

- Compose: `ow-backend` and `ow-worker` set `DATABASE_DIRECT_URL=postgres://app_user:…@postgres:5432/platform`.
- `.env.example` and `docs/local-setup.md` document both vars.

**Module split** (testability seam; public API unchanged)

- `packages/db/src/advisory-lock.ts`: pure lock logic over an injected `reserve()`; exports the acquire function, the pool-exhausted error, and the bounded-reserve helper.
- `packages/db/src/client.ts`: builds the lock client lazily, passes its `reserve`, re-exports `acquireTenantAdvisoryLock`.

## §R Requirements

R1: Mutual exclusion holds on the direct connection.
✓ with the lock client pointed at Postgres, a second acquire of the same key while the first is held returns `acquired: false`
✓ after `release()`, the next acquire returns `acquired: true`
✓ different keys (namespace or tenant) never block each other

R2: Crash safety is preserved.
✓ when the holding connection closes without `release()`, the lock becomes acquirable by another caller (opt-in integration test)

R3: Default behaviour is unchanged.
✓ with `DATABASE_DIRECT_URL` unset, no second pool is created and the main client is used
✓ existing org-directory and sandbox-reset tests pass unmodified

R4: Misconfiguration is visible.
✓ if the backend pid differs between acquire and release, an error log is written with `tenantId`, `namespace` and both pids
✓ if `pg_advisory_unlock` returns false, an error log is written, worded differently from the backend-switch case
✓ if the unlock query itself throws, an error log is written, the error is rethrown, and the connection is still released
✓ neither case throws from `release()`, and the connection is still released

R5: The wait for a pool slot is bounded and leak-free.
✓ with `DATABASE_DIRECT_URL` set and every slot busy, acquire rejects with the typed pool-exhausted error within the timeout
✓ a `reserve()` that resolves after the timeout has its connection released
✓ a failure between `reserve()` and the lock query releases the connection (existing behaviour, kept)

R6: Configuration is validated and documented.
✓ an invalid `DATABASE_DIRECT_URL` fails startup like `DATABASE_URL` does; `DATABASE_LOCK_POOL_MAX < 1` fails
✓ compose, `.env.example`, `docs/local-setup.md` and CHANGELOG describe the variable

R7: The fix is demonstrated against PgBouncer.
✓ the 40-iteration repro, run through the real stack with `DATABASE_DIRECT_URL` set, shows 0 double-grants (recorded in the week-log)

## §V Invariants

- A lock connection never comes from a transaction-pooled endpoint in a deployment that sets `DATABASE_DIRECT_URL`.
- Every code path that reserves a lock connection releases it (acquired, not acquired, error, timeout, late arrival).
- A lock anomaly is never silent.
- `acquireTenantAdvisoryLock`'s public signature never changes without a caller audit.

## §T Tasks

| id  | task                                                                            | phase | status | depends |
| --- | ------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Config: `DATABASE_DIRECT_URL`, `DATABASE_LOCK_POOL_MAX` + config tests          | 1     | todo   | —       |
| T2  | `advisory-lock.ts`: lock logic, pid/unlock checks, bounded reserve, typed error | 1     | todo   | —       |
| T3  | `client.ts`: lazy lock client, wiring, re-export (signature unchanged)          | 1     | todo   | T1,T2   |
| T4  | `packages/db` vitest setup + unit tests for R1 (fake connection), R3, R4, R5    | 1     | todo   | T2      |
| T5  | Opt-in PgBouncer/direct integration test (R1, R2) behind `PGBOUNCER_TEST_URL`   | 1     | todo   | T3      |
| T6  | Compose, `.env.example`, `docs/local-setup.md`, CHANGELOG, week-log             | 1     | todo   | T3      |
| T7  | Local verification through the real stack (R7), numbers into the week-log       | 1     | todo   | T3,T6   |

phase gate: typecheck, lint, test and test:isolation pass; R7 numbers recorded

Open items:

- **O1.** Lock-pool counter metric (ADR-015): deferred; needs either a telemetry dependency edge from `@platform/db` or a callback hook.
- **O2.** Hosted deployments behind a managed pooler need `DATABASE_DIRECT_URL` pointed at the provider's direct endpoint; document when the first hosted target is chosen.
- **O3.** A CI job with PgBouncer in front would make this regression-proof; needs a human to touch `.github/workflows`.

## §B Bugs / Backprop Log

| id  | what failed                                          | root cause                                                                              | promoted to §V?                                                     |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| B1  | #752: lock gave no mutual exclusion behind PgBouncer | session advisory locks assume one client = one backend; transaction pooling breaks that | yes: lock connections never come from a transaction-pooled endpoint |

---

_spec is source of truth — update as decisions are made_
