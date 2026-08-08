# Outbox: unconditional write + idempotent automation consumption (#143)

> automation-triggered transitions reach outbox_events again, w/o reintroducing #120 (double-exec / unbounded recursion). Unblocks ADR-009 Decision #3 (connector webhook gateway reads the outbox).

status: draft
created: 2026-08-09
updated: 2026-08-09

---

## §G Goal

- every `workflow.transitioned` transition writes to `outbox_events`, regardless of `triggeredBy` — no consumer (connector delivery, ADR-009; future outbox consumers) silently misses automation-caused transitions
- automation's own rule execution still fires exactly once per (rule, transition) — sync in-process path and async outbox→worker path for the same transition must not both run a rule's actions
- MAX_DEPTH recursion bound (executor.ts) still holds for the async path — currently dead code, must become live correctly

## §C Constraints

| constraint     | value                                                                                                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack          | TypeScript, Drizzle/Postgres, BullMQ (existing outbox-poller/automation-worker)                                                                                                                                                                                                                                        |
| touches        | `packages/workflow-engine` (engine.ts, types.ts), `packages/automation-engine` (executor.ts, actions/transition.ts, event-schemas.ts, types.ts), `packages/db` (schema/automation-engine.ts + new migration), `apps/worker` (automation-worker.ts — readDepth already there, no change expected)                       |
| governed by    | ADR-002 (workflow engine — outbox pattern, append-only events) · ADR-009 (connector runtime — Decision #3 is the consumer this unblocks; do NOT build connector code here, just don't block it)                                                                                                                        |
| out of scope   | connector runtime/webhook gateway itself (ADR-009 Stage 2) · `workflow_events` schema (already has its own unaffected `idempotency_key`) · non-`workflow.transitioned` outbox event types (`entity.created`/`entity.assigned` already carry depth correctly per existing tests — only the transition path has the gap) |
| test precedent | `notify.ts`'s `deriveNotificationId()` + `onConflictDoNothing` — same shape of problem (at-least-once delivery → exactly-once side effect), reused one level up (rule execution, not just notification send)                                                                                                           |

## §I Interfaces

**`TransitionRequest`** (`packages/workflow-engine/src/types.ts`) — no new field needed; `depth` already exists (line 88-91). Gap is purely that `engine.ts` never reads it into the outbox payload.

**`WorkflowTransitionedEvent` / `WorkflowTransitionedV1Schema`** (`event-schemas.ts`) — `depth` already declared optional. Add:

```ts
transitionEventId: string; // uuid, always set — the identity of THIS transition, stable across the sync in-process path and the async outbox→worker path for the same transition
```

Derived once per `executeTransition` call (e.g. `crypto.randomUUID()` generated inside the same function that builds `outboxPayload`, independent of `triggeredBy` — cheapest option, no dependency on `workflow_events`' own row id).

**`automation_executions`** (`packages/db/src/schema/automation-engine.ts`) — new migration:

```sql
ALTER TABLE automation_executions ADD COLUMN transition_event_id uuid;
CREATE UNIQUE INDEX automation_executions_rule_transition_idx
  ON automation_executions (rule_id, transition_event_id)
  WHERE transition_event_id IS NOT NULL;
```

Partial (nullable-safe) unique index, same pattern as `workflow_events_instance_idempotency_idx` (migration 0004). Nullable because only `workflow.transitioned`-sourced executions carry this key — other trigger types (`entity.created` etc.) are unaffected, `transition_event_id` stays `NULL` for them, and the partial index doesn't apply.

## §R Requirements

R1: `engine.ts`'s outbox write is unconditional — the `if (triggeredBy !== "automation")` guard is removed.
✓ a `triggeredBy: "automation"` transition produces a `workflow.transitioned` outbox row (currently: zero rows)
✓ existing `triggeredBy: "user"/"api"/"system"` behavior unchanged (still one outbox row each)

R2: every outbox-routed `workflow.transitioned` payload carries the transition's `depth` and a stable `transitionEventId`.
✓ `outboxPayload.depth === request.depth` for every `triggeredBy` (today: field exists on the type, never populated)
✓ `outboxPayload.transitionEventId` is a fresh uuid, generated once per `executeTransition` call, identical whether read back via the sync in-process path or the async worker path for the same transition

R3: a rule's actions execute at most once per `(ruleId, transitionEventId)` pair, regardless of whether the sync in-process path or the async outbox→worker path reaches it first.
✓ claim `automation_executions (rule_id, transition_event_id)` via `INSERT ... ON CONFLICT (rule_id, transition_event_id) WHERE transition_event_id IS NOT NULL DO NOTHING` **before** running the rule's action(s) — 0 rows affected ⇒ skip execution entirely (not just skip logging)
✓ non-transition-sourced executions (`transitionEventId` undefined) are unaffected — existing behavior for `entity.created`/`entity.assigned` etc. unchanged

R4: `MAX_DEPTH` bounding (executor.ts, currently 10) applies correctly to automation-triggered transitions reaching automation via the async outbox→worker path.
✓ an automation-triggered transition whose in-process recursion is already at depth D produces an outbox row with `depth: D+1` (via R2), and if that row is later consumed async, `executor.ts` enforces `MAX_DEPTH` against `D+1`, not `0`

## §V Invariants

- outbox write in `engine.ts` is unconditional on `triggeredBy` — the "skip on write" pattern from PR #139 must never come back; dedup lives in the consumer (R3), never in the producer
- `automation_executions`'s new unique index is partial (`WHERE transition_event_id IS NOT NULL`) — never make it a plain unique index, or non-transition-sourced executions (which share no natural key) would collide
- the claim-insert in R3 happens **before** any action side effect runs, never after — an after-the-fact dedup (like `notify.ts`'s current pattern) only prevents duplicate _logging_, not duplicate side effects, for actions that aren't naturally idempotent (e.g. `transition`, `create_child`)
- `transitionEventId` is generated inside `executeTransition` itself, not derived from `workflow_events`'/`outbox_events`' own row ids — those ids differ between the row a rule's in-process call is "rooted at" and the new row `engine.ts` writes for the transition it just performed; only a value threaded explicitly through both paths stays identical

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                            | phase | status | depends |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | migration: `automation_executions.transition_event_id` + partial unique index                                                                                                                                                                                                                   | 1     | todo   | —       |
| T2  | `engine.ts`: generate `transitionEventId`, populate `depth`+`transitionEventId` in `outboxPayload` for every `triggeredBy`, remove the skip guard                                                                                                                                               | 1     | todo   | T1      |
| T3  | thread `transitionEventId` through `TransitionRequest` (in-process recursive path, `actions/transition.ts`) so the sync path claims against the same key the async path will later see                                                                                                          | 1     | todo   | T2      |
| T4  | `executor.ts`: claim-insert against `automation_executions` before running a rule's action(s); skip action execution on conflict                                                                                                                                                                | 2     | todo   | T1,T3   |
| T5  | rewrite `automation-depth-recursion.isolation.test.ts`'s `"an automation-triggered transition writes no workflow.transitioned outbox row"` test — new contract: outbox row **is** written, `automationExecutions` count for the rule stays 1 (assertion b unchanged, assertion a inverted)      | 2     | todo   | T4      |
| T6  | new isolation test: sync-then-async race — feed the same `transitionEventId` through both the in-process path and a simulated outbox-poller consumption of the row `engine.ts` wrote; assert exactly 1 `automation_executions` row and the rule's side effect (e.g. a counter) incremented once | 2     | todo   | T4      |
| T7  | new isolation test: `MAX_DEPTH` still enforced when depth arrives via the async path (previously untestable — the path was dead code)                                                                                                                                                           | 2     | todo   | T2      |

phase gate: all unit + isolation tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                                                     | root cause                                                                                                                                 | promoted to §V? |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| —   | (pre-emptive, found during spec research, not yet built) — naively removing PR #139's skip guard without T2/T3 would silently re-break #120: async path would read `depth ?? 0`, resetting recursion bound to 0 | `depth` was declared on the outbox event type but never populated — dead code because the only branch needing it was the one being skipped | yes → §V item 4 |

---

_spec is source of truth — update as decisions are made_
