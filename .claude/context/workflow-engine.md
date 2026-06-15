# Workflow Engine — Context Guide

Load this when working in `packages/workflow-engine/`, touching transitions, SLA timers,
workflow definitions, or the immutable event log.

---

## What it does

Finite state machine executor. Workflow definitions (states + transitions + guards) are
database rows. The engine enforces guards (role check, condition tree, required fields),
acquires a pessimistic lock, writes the state change + immutable event log + outbox event
atomically, and schedules/cancels SLA timers via the outbox.

---

## Key functions

| Function                    | Purpose                                                                          |
| --------------------------- | -------------------------------------------------------------------------------- |
| `executeTransition()`       | Apply state change — lock, guards, atomic write, outbox                          |
| `getAvailableTransitions()` | List valid transitions from current state (filters by role + condition silently) |
| `getWorkflowEventLog()`     | Read the immutable append-only transition log for an instance                    |
| `evaluateConditionTree()`   | Evaluate an and/or/not/field-comparison tree against entity fields               |
| `createWorkflow()` / CRUD   | Manage workflow definitions, states, transitions                                 |

---

## Invariants that will surprise you

**Pessimistic lock with `FOR UPDATE NOWAIT`.** `executeTransition()` acquires an exclusive row
lock on the entity instance. If another transaction holds it, Postgres throws `55P03`
immediately — the engine re-throws as `TRANSITION_LOCKED` (423). Callers must retry with
backoff. This prevents TOCTOU races between reading `currentState` and writing the update.

**Transitions are irreversible by design.** There is no undo. A reverse transition must be
explicitly defined in the workflow config. See ADR-002 (WE-02).

**`workflow_events` is append-only.** Rows are never updated or deleted. It is an immutable
audit log. Do not add UPDATE or DELETE paths to this table.

**Idempotency via `idempotencyKey`.** If the same key has already been used, the existing
event is returned immediately — no guards re-evaluated, no state written. Safe to retry.

**SLA timers use the outbox.** Entering a state with `slaHours` writes a `workflow.sla_scheduled`
event to `outbox_events`. Leaving that state marks undelivered SLA outbox events as delivered
(cancels them). Both the state write and the SLA cancel/schedule commit in the same transaction.

**Metadata redaction happens at INSERT time.** Fields marked `sensitivity: 'pii'` or
`'financial'` on the entity type are replaced with `[REDACTED]` in `workflow_events.metadata`
before the row is written.

---

## Tables owned / read

Owned: `workflows`, `workflow_states`, `workflow_transitions`, `workflow_events`

Reads: `entity_instances` (current state + fields), `entity_fields` (sensitivity metadata),
`outbox_events` (SLA cancellation)

---

## Errors

`WorkflowError` codes: `INSTANCE_NOT_FOUND`, `TRANSITION_NOT_AVAILABLE`, `TRANSITION_FORBIDDEN`,
`TRANSITION_LOCKED` (423 — transient, retry), `CONDITION_NOT_MET`, `REQUIRED_FIELDS_MISSING`,
`SLA_TIMER_FAILED`, `WORKFLOW_NOT_FOUND`, `WORKFLOW_STATE_NOT_FOUND`.

---

## Gotchas

- `TRANSITION_LOCKED` is **transient** — return 423 with `Retry-After` header. Never 409.
  The lock releases when the competing transaction commits (usually milliseconds).
- `getAvailableTransitions()` silently omits transitions the actor can't take (role mismatch
  or condition false). The client cannot distinguish the two — by design.
- Condition evaluation is **short-circuit**: `and` stops at first false, `or` stops at first true.
- SLA cancellation is inside the transaction. If the transaction rolls back, SLA timers
  remain scheduled — they will fire if the state change is never retried.
