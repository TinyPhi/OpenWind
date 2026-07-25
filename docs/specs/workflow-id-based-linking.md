# Workflow ID-Based Linking

> Steps/Transitions link by stable ID not name; safe rename, warn-then-reconnect delete, auto-created Archive step. For workflow builder admins/creators.

status: draft
created: 2026-07-23
updated: 2026-07-23

---

## §G Goal

Renaming a workflow Step never breaks anything downstream. Deleting a connected Step
never silently orphans the flow or in-flight tickets — user is warned, then the
system auto-reconnects Transitions and re-files affected tickets into a system
Archive step. Steps/Transitions/rename/delete keep working for every existing
module (helpdesk, tender, NSI, sales-pipeline, etc.) with zero manual migration.

## §C Constraints

| constraint                                                | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack                                                     | Hono API (`apps/api`), `@platform/workflow-engine`, `@platform/entity-engine`, `@platform/automation-engine`, Drizzle/Postgres (`packages/db`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| auth                                                      | Reuse existing per-workflow admin check (`isWorkflowAdmin`: `createdBy`/`assignedTo`/global admin) — no new permission model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| existing tables                                           | `workflow_states` (id, workflowId, name, label, ...), `workflow_transitions` (id, workflowId, fromState, toState as TEXT — no FK today), `entity_instances.current_state` (TEXT, entity-engine package — same name-based scheme, compared directly against `transition.fromState`/`toState` in `executeTransition`)                                                                                                                                                                                                                                                                                                                        |
| **scope note (discovered during Phase 1 implementation)** | `entity_instances.currentState` is ALSO a plain state-name string, compared directly against `workflow_transitions.fromState`/`toState` in `packages/workflow-engine/src/engine.ts:133,193,255-256`, looked up by name for SLA hours (`scheduleSlaIfNeeded:501-506`), and propagated as a name string into the `workflow.sla_breached` outbox event consumed by `packages/automation-engine`'s `WorkflowSlaBreachedV1Schema`. Converting `workflow_transitions` to ID-based without also converting `entity_instances.currentState` breaks every transition (ID vs name comparison never matches). Scope is expanded accordingly — see §I. |
| out of scope                                              | Canvas/visual layout — canvas is purely a rendering of Transitions data, no separate canvas data model or behavior to design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| out of scope                                              | Initial-state fallback on delete (promote top-of-Steps-list step) — deferred to v2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| out of scope                                              | Last-real-step-undeletable guard — deferred to v2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| out of scope                                              | Preserving conditions/allowedRoles/etc. on auto-created Transitions — they start blank by design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## §I Interfaces

**`workflow_transitions.fromState` / `toState`**: change from TEXT (state name) to a
stable reference to `workflow_states.id`. Existing rows must be backfilled by
resolving current name → id at migration time.

**`workflows.initialState`**: same change — TEXT name → `workflow_states.id` reference.

**New system step per workflow**: `Archive`

- Auto-created when a workflow is created (or lazily on first delete, for existing
  workflows) — always exists, `isTerminal = true`, cannot itself be deleted
- Visible in the Steps tab like a normal step; label/color editable; the fact that
  it's the system archive target and its undeletability are locked
- Tickets only leave Archive via a real Transition (no "any state" bypass) —
  identical rule to every other step; kanban drag-drop filter and
  `executeTransition` engine validation (`packages/workflow-engine/src/engine.ts`)
  need zero special-casing for this

**`entity_instances.currentState`**: change from TEXT (state name) to a stable
reference to `workflow_states.id`, mirroring `workflow_transitions`. Every
read/write site (`packages/entity-engine/src/engine.ts`, `child-relations.ts`,
`search.ts`, `export-utils.ts`) that compares, sets, or serializes this column
must switch to ID comparisons; any external-facing API response that currently
returns the state name must resolve ID → name/label at the response boundary
(entity instances are read by end users — must not start showing raw UUIDs).

**Automation-engine: NO changes required.** Verified against
`modules/tender/seed/003_automation_rules.sql:39` — `automation_rules.conditions`
reference states by name string (e.g. `{"field":"toState","value":"pending_costing_review"}`),
because seed SQL is installed per-tenant and cannot know a state's
auto-generated UUID in advance. Automation conditions must stay name-based
permanently — there is no ID-based alternative here. Therefore
`packages/workflow-engine/src/engine.ts` must resolve state ID → name when
building `WorkflowTransitionedEvent`/`WorkflowSlaBreachedEvent` outbox
payloads (denormalize at the point of writing the event), exactly as it does
today. `packages/automation-engine`'s event schemas and every module's seed
SQL are untouched by this spec.

**Delete-Step API** (extends existing `deleteWorkflowState` in
`packages/workflow-engine/src/workflow-crud.ts`):

1. Look up all Transitions where `fromState = stepId OR toState = stepId`
2. If none exist and no entity instances currently reference this step as
   `currentState` → delete immediately, no warning
3. If any exist → return a warning payload (counts of affected Transitions +
   in-flight tickets) requiring explicit confirm before proceeding
4. On confirmed delete:
   a. Move every entity instance with `currentState = stepId` to Archive
   (write a `workflow_events` row, `triggeredBy: "system"`, so this is
   auditable exactly like a normal transition — not a silent side-door,
   consistent with the #127 hardening item's spirit)
   b. Cross-product reconnect: for every (incoming Transition, outgoing
   Transition) pair, create a new Transition `incoming.fromState →
outgoing.toState` with blank `conditions`/`allowedRoles`/etc.
   c. Additionally create Transitions `Archive → outgoing.toState` for every
   outgoing Transition the deleted step had, so freshly-archived tickets
   have somewhere to go
   d. Delete the original Transitions and the Step row

## §R Requirements

R1: Transitions reference Steps by stable ID, not name/label
✓ Renaming a Step's internal name via `updateWorkflowState` does not require
touching any `workflow_transitions` row (no cascading rename needed at all —
contrast with the current cascading-rename implementation, which becomes
dead code once this ships)
✓ An existing in-flight ticket continues to transition correctly through a
workflow after one of its Steps has been renamed

R2: Steps have no inherent order/connection between each other
✓ Drag-reordering Steps in the Steps tab changes only their `sortOrder`
(display order) — zero Transitions are created, modified, or deleted as a
result of a pure reorder

R3: Deleting a connected Step warns first, then auto-reconnects
✓ Deleting a Step with zero attached Transitions and zero in-flight tickets
succeeds immediately with no warning prompt
✓ Deleting a Step with attached Transitions and/or in-flight tickets shows a
warning (counts of affected Transitions + tickets) and requires explicit
confirmation before proceeding
✓ After confirmed delete of a Step with 2 incoming + 3 outgoing Transitions,
exactly 6 new Transitions exist (cross-product), each with blank
conditions/allowedRoles, plus 3 new `Archive → X` Transitions (one per
original outgoing destination)
✓ After confirmed delete of a Step with only incoming Transitions (zero
outgoing), zero cross-product Transitions are created (incoming
Transitions are simply removed) — this is expected, not a bug
✓ Every entity instance with `currentState` pointing at the deleted Step is
moved to Archive, with a `workflow_events` row recording the system-triggered
transition

R4: Archive is a real, transition-locked step
✓ A ticket in Archive can only move to another step via an explicit
Transition from Archive — the kanban drag-drop filter and
`executeTransition` engine check require zero special-case code for Archive
✓ Archive cannot be deleted (delete attempt returns a clear error)
✓ Archive is visible in the Steps tab; label and color are editable, its
system-managed flag and undeletability are not

R5: Existing modules keep working, zero manual migration
✓ A migration backfills `workflow_transitions.fromState`/`toState` and
`workflows.initialState` from name-string to `workflow_states.id` for every
existing workflow, and it is idempotent (safe to re-run)
✓ Existing seed SQL for helpdesk/tender/NSI/sales-pipeline modules installs
and functions identically after the migration (verified by running each
module's install + a full transition end-to-end)

## §V Invariants

- A `workflow_transitions` row's `fromState`/`toState` always references an
  existing `workflow_states.id` in the same workflow — never a dangling ID,
  never a raw name string
- Every workflow has exactly one Archive step, always terminal, always
  undeletable
- Deleting a Step is never a silent operation on in-flight tickets — every
  ticket moved to Archive as a side effect gets its own auditable
  `workflow_events` row (no direct `currentState` mutation without an event
  row — same guarantee the #127 hardening item requires for
  `setEntityState`/`bulkSetState`, applied here too)

## §T Tasks

| id  | task                                                                                                          | phase | status | depends |
| --- | ------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Migration: add Archive step to every existing workflow                                                        | 1     | todo   | —       |
| T2  | Migration: backfill `fromState`/`toState`/`initialState` name→id                                              | 1     | todo   | T1      |
| T3  | Schema: change columns to FK-referenced ID type, add FK constraints                                           | 1     | todo   | T2      |
| T4  | Engine: update `executeTransition`/`addWorkflowTransition`/etc. to use ID comparisons instead of name strings | 1     | todo   | T3      |
| T5  | Engine: remove cascading-rename logic from `updateWorkflowState` (dead code once linking is by ID)            | 1     | todo   | T4      |
| T6  | Engine: delete-Step warning payload (counts of affected Transitions + tickets)                                | 2     | todo   | T4      |
| T7  | Engine: cross-product reconnect + Archive auto-routing on confirmed delete                                    | 2     | todo   | T6      |
| T8  | Engine: move in-flight tickets to Archive on confirmed delete, with `workflow_events` row                     | 2     | todo   | T7      |
| T9  | API: update delete-state route to surface warning payload + confirm flow                                      | 2     | todo   | T6      |
| T10 | Admin UI: warning modal on delete, showing affected Transition/ticket counts                                  | 2     | todo   | T9      |
| T11 | Admin UI: Archive step shown in Steps tab, locked delete button, editable label/color                         | 2     | todo   | T1      |
| T12 | Verify: all existing module seeds install + full transition cycle passes post-migration                       | 1     | todo   | T3      |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                           | root cause                                                                                                                                                                                                                                                                                | promoted to §V?                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| B1  | Original ask ("reorder changes flow sequence") conflicted with actual engine design (flow = Transitions graph, not Step order)                                        | User initially assumed Steps form an implicit sequence; corrected mid-interview once actual engine model (Steps are unconnected named blocks, Transitions are the real graph) was restated                                                                                                | Yes — R2                                                                                       |
| B2  | Cross-product reconnect for branching deletes has no answer for "which original Transition's conditions/roles apply"                                                  | N-to-M pairing has no canonical source side to copy from                                                                                                                                                                                                                                  | Yes — new Transitions start blank by design (§C)                                               |
| B3  | Priority-cut answer (defer Archive) conflicted with delete-reconnect's dependency on Archive existing                                                                 | Archive isn't a separable nice-to-have — it's the destination delete-reconnect requires for in-flight tickets                                                                                                                                                                             | Yes — Archive pulled back into v1 must-have scope                                              |
| B4  | Discovered mid-Phase-1 that `entity_instances.currentState` (entity-engine) is also name-based and would break transitions if only `workflow_transitions` moved to ID | Original spec scoped only `packages/workflow-engine`/`packages/db`; `currentState` lives in a different package (`entity-engine`) and wasn't accounted for                                                                                                                                | Yes — §I expanded, plan-lock re-frozen with `packages/entity-engine/**` in scope               |
| B5  | Initially assumed automation-engine event schemas also needed ID migration                                                                                            | Verified against `modules/tender/seed/003_automation_rules.sql:39` — seed SQL conditions reference states by name and cannot know auto-generated UUIDs ahead of install, so automation must stay name-based permanently; engine.ts resolves ID→name when building outbox payloads instead | Yes — §I documents automation-engine as explicitly untouched, denormalization point identified |

---

_spec is source of truth — update as decisions are made_
