# Segregation of duties — actor-aware transition conditions

> Let a workflow say "the person who raised this cannot approve it" and "each stage needs a
> different person", enforced by the engine inside the transition lock instead of by convention.

status: in-progress
created: 2026-10-14
updated: 2026-10-14

---

## §G Goal

A workflow author can require that the actor on a transition is not the record's creator and has
not already acted on the instance, with no TypeScript in `modules/` and no schema change. The rule
is evaluated by the same engine path that checks roles and conditions, under the same row lock.

## §C Constraints

- Config-first (ADR-004): the rules live in a transition's existing `conditions` jsonb.
- A rule needing an identity fails closed: automation and system actors, which have no user id,
  satisfy neither rule.
- Automation rules share `ConditionTree` and must not be able to use these rules (they have no
  actor), so the actor rules are a transition-only superset type, `TransitionConditionTree`.

## §D Decisions

- **D1 — operators, not a new column.** Two new condition operators extend the evaluator, which
  ADR-002 WE-04 allows once a concrete module needs one (`vendor-approval` does).
- **D2 — `actor_not_creator` and `actor_is_creator`.** True iff the actor is identified and is not (or is)
  `entity_instances.created_by`. The positive form exists so "only the requester may withdraw" never needs `not`.
- **D3 — `actor_not_prior_actor`, optional `states`.** True iff the actor is identified and has
  not performed a transition on this instance. With `states`, only earlier transitions that left one
  of those states count. "Acted" means a real state change (`from_state` differs from `to_state`), which
  is set by the server. Comments, tags, severity, attachment and access events record the current state as
  both and never count. Caller-written `metadata` is never used to classify an event: a transition sent with
  `metadata.type = "comment"` still counts.
- **D3a — only real users count.** An API key's identity (`apikey:<id>`), `system` and an empty actor are not
  users, and satisfy no actor rule. Otherwise a record's creator could approve it through a key, and rotating
  the key would reset "already acted".
- **D3b — no actor rule under `not`.** Every actor rule fails closed for an unidentified actor, and `not` would
  invert that refusal into a pass. The schema rejects it at write time and the evaluator never satisfies one,
  for rows that arrived another way (seed SQL).
- **D4 — context loaded inside the lock.** `executeTransition` loads the creator and, only when a rule
  needs it, the instance's prior actors after `FOR UPDATE NOWAIT`, so the history cannot change
  under the decision. A workflow with no actor rule pays no extra query.
- **D5 — one context for check and offer.** `getAvailableTransitions` takes the actor id and applies the
  same context, so the UI is never offered a transition the engine will refuse.
- **D6 — validated at write time.** The transition create and update routes validate `conditions`
  (known operators, structure, depth at most 8, groups at most 20) instead of accepting `unknown`, so a typo
  is a 400 rather than a transition nobody can take. The schema is built to a fixed depth rather than
  recursing lazily, so a deeply nested payload cannot recurse before the limit applies.
- **D6a — `states` must name real steps, and a named step is protected.** A name no step has would match no
  event, so the rule would block nobody (fail open). `addWorkflowTransition` and `updateWorkflowTransition`
  reject unknown names (`WORKFLOW_CONDITION_STATE_UNKNOWN`, 422). Renaming or deleting a step that a rule names
  is refused (`WORKFLOW_STATE_IN_USE`): past events keep the name they were written with, so a rename would leave
  the rule matching nothing for everything before it. Change the rule first.
- **D7 — changes to a rule are audited.** Creating, changing, clearing or deleting a transition that carries
  conditions writes `workflow.transition_conditions_updated` (migration 0145). Removing a rule is how a control
  is quietly switched off, so it leaves a record in the same transaction.

## §K Known limits

- **Scope.** These rules guard transitions executed through the workflow engine. Direct state writes
  (`PATCH /entities/:id` with `currentState`, `POST /entities/:id/state`, `POST /entities/bulk/state`, and a create
  in a later step) skip transition guards, so they are refused on any workflow that carries an actor rule
  (`STATE_CHANGE_NOT_ALLOWED`, docs/specs/state-override.md T6). The child-status route only moves child tickets,
  which keep their own fixed states. A workflow with no actor rule and no override is unchanged.
- **A workflow admin can remove a rule.** The transition edit and delete routes accept a workflow admin who is not a
  tenant admin, so that person can clear a transition's `conditions` (audited as
  `workflow.transition_conditions_updated`, not blocked). On a workflow without the override switch the direct-write
  lock is derived from those conditions, so removing the last actor rule also lifts it. Vendor-approval ships the
  switch on, so its lock holds. Restricting removal or change of `actor_*` conditions to a tenant admin who is a
  person is a follow-up (an API decision).
- A record with no user creator (created by the scheduler or an automation) has no conflict for
  `actor_not_creator`: any identified actor passes. Pinned by a unit test in `condition-evaluator.test.ts`.
- A transition that does not change state (a self-loop) never counts as acting, so a workflow that uses
  a self-loop as an approval step lets the same person repeat it.
- Two transitions between the same pair of steps, one with a rule and one without, let the caller pick the
  unguarded one. Author workflows with one edge per pair, or put the rule on both.
- Deleting a whole workflow removes its transitions and their conditions without a
  `workflow.transition_conditions_updated` entry; canvas edits that re-point an existing transition log its
  conditions as unchanged. Workflow deletion is blocked while instances exist.
- A partner API key names the acting person; the rules trust that asserted id by design (ADR-012). The
  key's own identity (`apikey:<id>`) never satisfies a rule.
- The seed worker runs transitions as `system` on a plain database handle, which satisfies no actor rule and
  reads no lock. A seeded workflow that uses these rules needs the override.

## §R Requirements

- R1: `actor_not_creator` refuses the record's creator and allows anyone else who is identified.
- R2: `actor_not_prior_actor` refuses anyone who already performed a transition on the instance, and
  with `states` only those who left a listed state.
- R3: both fail closed with no actor, and when the prior actors were not loaded.
- R4: comments do not count as acting; history is per instance and per tenant.
- R5: `getAvailableTransitions` hides what the guard would refuse.
- R6: a transition without an actor rule behaves exactly as before.
- R7: an unknown operator or malformed tree on a transition is rejected at write time.
- R8: an API-key, system or empty actor satisfies no actor rule; neither does an actor rule under `not`.
- R9: a transition's own `metadata` cannot make it stop counting as acting.
- R10: every change to a transition's conditions is audited.
- R11: a rule's `states` must name real steps when saved, and a step named by a rule cannot be renamed or deleted.

## §T Tasks

| id  | task                                                                                      | req    | status |
| --- | ----------------------------------------------------------------------------------------- | ------ | ------ |
| T1  | Types, evaluator, `treeNeedsPriorActors`, unit tests                                      | R1–R3  | done   |
| T2  | Engine: `loadActorContext` in `executeTransition` and `getAvailableTransitions`           | R4, R5 | done   |
| T3  | Write-time `TransitionConditionsSchema` on create and update routes                       | R7     | done   |
| T4  | Real-Postgres isolation test (creator, distinct approver, states, fail closed, tenant)    | R1–R6  | done   |
| T5  | Security-review fixes: structural event classification, non-user actors, `not` guard      | R8–R9  | done   |
| T6  | Audit action `workflow.transition_conditions_updated` + migration 0145 + four write paths | R10    | done   |
| T7  | `vendor-approval` seed uses the rules and drops blanket `admin` (needs the override)      | —      | done   |
