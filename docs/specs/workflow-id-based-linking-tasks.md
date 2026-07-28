# Implementation Plan: Workflow ID-Based Linking

**Spec:** docs/specs/workflow-id-based-linking.md
**Generated:** 2026-07-23
**Status:** not started

---

## Phase 1 — Core Domain (migration + engine linking)

**Goal:** Transitions/initialState reference Steps by stable ID; every workflow has an
Archive step; existing modules keep working with zero manual migration.
**Gate:** all unit + integration tests pass, plus T12 module-install verification → then Phase 2

| task                                                                                                                                                                                                                                                                                                                                              | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Migration — add Archive step to every existing workflow (terminal, undeletable, system-managed flag)                                                                                                                                                                                                                                          | R4, R5      | todo   |
| T2: Migration — backfill `workflow_transitions.fromState`/`toState`, `workflows.initialState`, and `entity_instances.current_state` from name string → `workflow_states.id`, idempotent                                                                                                                                                           | R1, R5      | todo   |
| T3: Schema — change `fromState`/`toState`/`initialState`/`current_state` columns to FK-referenced ID type, add FK constraints (`workflow-engine.ts` + `entity-engine.ts` schema files)                                                                                                                                                            | R1, R5      | todo   |
| T4: Engine — update `executeTransition`, `addWorkflowTransition`, `createWorkflow`, `getAvailableTransitions`, `scheduleSlaIfNeeded`/`cancelPendingSlaTimers` to use ID comparisons; resolve ID→name when building outbox `WorkflowTransitionedEvent`/`WorkflowSlaBreachedEvent` payloads so automation-engine and module seed SQL are unaffected | R1, R2      | todo   |
| T4b: entity-engine — update `engine.ts`, `child-relations.ts`, `search.ts`, `export-utils.ts` read/write sites for `currentState` to use IDs internally; resolve ID→name/label at any API response boundary                                                                                                                                       | R1, R5      | todo   |
| T5: Engine — remove cascading-rename logic from `updateWorkflowState` (dead code once linking is by ID)                                                                                                                                                                                                                                           | R1          | todo   |
| T12: Verify — all existing module seeds (helpdesk, tender, NSI, sales-pipeline) install cleanly, automation rules still match on state name in outbox events, and a full create→transition→terminal cycle passes post-migration                                                                                                                   | R5          | todo   |

---

## Phase 2 — Service/API Layer (delete-warn-reconnect)

**Goal:** Deleting a connected Step warns first, then auto-reconnects Transitions and
re-files in-flight tickets into Archive, all as an auditable operation.
**Gate:** integration tests pass + Phase 1 gate still green

| task                                                                                                                                                                | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T6: Engine — delete-Step warning payload: count affected Transitions + in-flight ticket instances, short-circuit to immediate delete if both are zero               | R3          | todo   |
| T7: Engine — cross-product reconnect (incoming × outgoing → new blank Transitions) + auto-create `Archive → outgoing.toState` Transitions                           | R3, R4      | todo   |
| T8: Engine — move in-flight tickets (`currentState = deleted step`) to Archive, writing a `workflow_events` row (`triggeredBy: "system"`) per moved ticket          | R3, §V      | todo   |
| T9: API — update delete-state route (`apps/api/src/routes/workflows/states/delete-state.ts`) to return the warning payload on first call, execute on confirmed call | R3          | todo   |

---

## Phase 3 — Consumer Integration (admin UI)

**Goal:** Admins see the warning before deleting a connected Step, and Archive is
visible (but locked) in the Steps tab like any other step.
**Gate:** §R acceptance criteria met (manual verification against a real workflow with branching Transitions)

| task                                                                                                               | requirement | status |
| ------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T10: Admin UI — warning modal on Step delete showing affected Transition/ticket counts, requiring explicit confirm | R3          | todo   |
| T11: Admin UI — Archive step shown in Steps tab; delete button disabled/locked; label + color remain editable      | R4          | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/workflow-id-based-linking.md and docs/specs/workflow-id-based-linking-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3, T4, T4b, T5, T12).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
