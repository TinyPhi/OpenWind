# Connector Polling Scheduler

> BullMQ repeatable job per (tenantId, connectorId) polling-connector installation — the pull-side counterpart to the existing inbound webhook gateway push path.

status: draft
created: 2026-08-18
updated: 2026-08-18

---

## §G Goal

- Every `connector_credentials` installation whose connector definition declares a `type: "polling"` trigger gets polled on that trigger's `intervalMinutes`, with no install-time registration call required.
- Polled events reach the same downstream queue (`connector-inbound`) the webhook gateway already produces onto, in the same job shape.
- Uninstall / interval change is picked up within one reconcile tick, no manual unschedule call.

## §C Constraints

| constraint      | value                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack           | BullMQ (Redis), Drizzle/Postgres, `@platform/connector-sdk`                                                                                                           |
| auth            | credentials decrypted server-side only, via `createConnectorContext` — never exposed to connector code as plaintext                                                   |
| existing schema | `connector_credentials.cursor_state` (jsonb, nullable) already exists (migration 0056) — **no new migration**                                                         |
| out of scope    | kill switch / disabled flag (#367), real connector definitions (#368), install/uninstall API route (#369), a consumer `Worker` for `connector-inbound` (future issue) |
| perf            | reconcile tick every 5 min (no strict SLA on poll-start latency)                                                                                                      |

## §I Interfaces

```ts
// apps/worker/src/queues.ts — new export
export const connectorPollQueue = Queue("connector-poll", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
  },
});

// connector-poll job data
type ConnectorPollJobData = { tenantId: string; connectorId: string };

// cursor_state jsonb shape (v1 — only key ever read/written)
type CursorState = { cursor?: string };

// downstream produce — same shape apps/api's webhook handler already uses
connectorInboundQueue.add(
  "connector.inbound",
  { tenantId, connectorId, deliveryId, event },
  { jobId: deliveryId },
);
```

Repeatable-job jobId convention: `connector-poll:{tenantId}:{connectorId}` — deterministic, one BullMQ repeatable descriptor per installation.

Per-event deliveryId convention: derived from `(tenantId, connectorId, cursorBeforeThisPoll, eventIndex)` — stable across retries of the same poll job so a retry re-enqueues identical jobIds instead of duplicating.

## §R Requirements

R1: Every polling-type connector installation is polled on its declared interval without an explicit schedule/unschedule call site.
✓ A `connector_credentials` row for a registered polling connector gets a BullMQ repeatable job within one reconcile tick of the row existing.
✓ Deleting the row (or deregistering the connector, or its trigger no longer being `polling`) removes the repeatable job within one reconcile tick.
✓ Changing a connector's `intervalMinutes` between deploys updates the repeatable job's `every` within one reconcile tick (no orphaned duplicate descriptor).

R2: A poll job resolves the installation, calls the connector's `fetch(ctx, cursor)`, and hands off every returned event to the existing inbound queue.
✓ `ConnectorContext` is built via `createConnectorContext` — connector code never receives raw credentials.
✓ Each event is enqueued onto `connector-inbound` with the exact job-data shape `{ tenantId, connectorId, deliveryId, event }` and `jobId: deliveryId`.
✓ `cursor_state.cursor` is updated to `nextCursor` only after all events for that poll have been enqueued.

R3: A poll job failure does not lose or duplicate events.
✓ If `fetch()` throws, the job fails, BullMQ retries per `attempts: 3`, and `cursor_state` is unchanged (retry re-fetches from the same starting cursor).
✓ A retried poll re-enqueues the same `jobId`s as the first attempt — BullMQ inbound-queue dedup absorbs the retry, no duplicate downstream events.

R4: Missing/inactive state is handled by skipping, not throwing.
✓ Inactive tenant (per `validateActiveTenant`) → job returns without processing, no error logged as a failure.
✓ Connector no longer registered, or its trigger no longer `type: "polling"` → job logs a warning and returns (reconciler cleans up the stale repeatable job on its own next tick).
✓ Installation row no longer exists → job logs a warning and returns.

## §V Invariants

- `cursor_state` is only ever advanced after every event derived from the poll that produced `nextCursor` has been durably enqueued — never advance-then-enqueue.
- The reconciler is the _only_ place a `connector-poll` repeatable job is created or removed — no other code path schedules/unschedules one.
- A poll worker never calls `decryptCredential` directly — always through `createConnectorContext`, so the SSRF/allowedHosts checks in `runtime.ts` stay in the loop for every outbound call a `fetch()` implementation makes.

## §T Tasks

| id  | task                                                                                                                                                                                                                   | phase | status | depends |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | `connectorPollQueue` in `apps/worker/src/queues.ts`                                                                                                                                                                    | 1     | todo   | —       |
| T2  | `connector-poll-scheduler.ts` — reconcile tick (list installations, resolve registry, diff against `getRepeatableJobs()`, add/remove) + start/stop pair                                                                | 1     | todo   | T1      |
| T3  | `connector-poll-worker.ts` — `Worker` consuming `connector-poll`, full fetch→enqueue→cursor-update flow + stop fn                                                                                                      | 1     | todo   | T1      |
| T4  | Wire start/stop into `apps/worker/src/index.ts`                                                                                                                                                                        | 1     | todo   | T2,T3   |
| T5  | Isolation test: extend `connector-credentials.isolation.test.ts` with `cursor_state` round-trip + RLS coverage                                                                                                         | 2     | todo   | —       |
| T6  | Unit tests: `connector-poll-scheduler.test.ts` (diff logic — add/remove/update-interval cases), `connector-poll-worker.test.ts` (fetch success, fetch throw, missing definition/trigger/installation, inactive tenant) | 2     | todo   | T2,T3   |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
