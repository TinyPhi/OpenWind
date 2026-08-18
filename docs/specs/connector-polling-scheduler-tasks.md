# Implementation Plan: Connector Polling Scheduler

**Spec:** docs/specs/connector-polling-scheduler.md
**Generated:** 2026-08-18
**Status:** not started

---

## Phase 1 — Runtime (queue, scheduler, worker)

**Goal:** A working reconcile-tick scheduler and poll worker, wired into `apps/worker`.
**Gate:** all unit tests pass → then Phase 2

| task                                                                                                                                                                                                                                                                                                                                                                | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: `connectorPollQueue` in `apps/worker/src/queues.ts`                                                                                                                                                                                                                                                                                                             | R1, R2      | todo   |
| T2: `connector-poll-scheduler.ts` — reconcile tick (list installations cross-tenant, resolve registry, diff against `getRepeatableJobs()`, add/remove/update) + `startConnectorPollScheduler`/`stopConnectorPollScheduler`                                                                                                                                          | R1          | todo   |
| T3: `connector-poll-worker.ts` — `Worker` consuming `connector-poll`: `validateActiveTenant` guard, re-resolve definition+trigger (skip if missing), load installation (skip if missing), build `ConnectorContext`, `fetch(ctx, cursor)`, enqueue events onto `connectorInboundQueue`, update `cursor_state` only after enqueue succeeds, `stopConnectorPollWorker` | R2, R3, R4  | todo   |
| T4: Wire `startConnectorPollScheduler`/`stopConnectorPollScheduler` into `apps/worker/src/index.ts` start list and shutdown `Promise.all([...])`                                                                                                                                                                                                                    | R1          | todo   |

---

## Phase 2 — Tests

**Goal:** Prove the reconcile diff logic, the worker's full flow, and `cursor_state`'s RLS isolation.
**Gate:** §R acceptance criteria met

| task                                                                                                                                                                                                                                                                      | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T5: Extend `apps/api/tests/isolation/connector-credentials.isolation.test.ts` with `cursor_state` round-trip + cross-tenant RLS denial                                                                                                                                    | R2          | todo   |
| T6: `connector-poll-scheduler.test.ts` — diff logic: new installation → job added; removed installation → job removed; changed `intervalMinutes` → job's `every` updated, no orphan descriptor; unregistered connector / non-polling trigger → skipped                    | R1          | todo   |
| T7: `connector-poll-worker.test.ts` — fetch success → events enqueued with correct jobId/shape + cursor advances; fetch throws → cursor unchanged, job fails for BullMQ retry; missing definition/trigger/installation → skip, no throw; inactive tenant → skip, no throw | R2, R3, R4  | todo   |

---

## Kick-Off Prompt

```
Read docs/specs/connector-polling-scheduler.md and docs/specs/connector-polling-scheduler-tasks.md.

Implement Phase 1 tasks only (T1-T4).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
