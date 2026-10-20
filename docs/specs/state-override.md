# Guarded state override

> One sanctioned, recorded way for an admin to move a record to a chosen step outside its workflow's
> transitions, for the cases the transitions cannot fix, and nothing broader.

status: in-progress
created: 2026-10-14
updated: 2026-10-14

---

## §G Goal

Transitions are irreversible by design (ADR-002 WE-02), so a record that is in the wrong step through a
mistake, an escalation or a changed process needs a way out. That way must be explicit, narrow, reasoned,
attributable, and subject to the same rules as any other change of state where those still apply.

## §C Constraints

- Config-first (ADR-004): a per-workflow switch, off by default; no TypeScript in `modules/`.
- It behaves like a transition in every way that matters: row lock, event, outbox event, SLA timers.
- Only a real admin user. Never an API key, `system`, automation, or a partner key's asserted person.
- It never replaces the guarded transition for ordinary work; it is the exception path.

## §D Decisions

- **D1 — a per-workflow switch, off by default** (`workflows.allow_state_override`, migration 0146), mirroring
  `allow_auto_grant_on_mention`. Turning it on or off is a tenant admin's decision, not any workflow admin's, must be made by a person (an API key
  holding the admin scope is refused), and is audited (`workflow.override_policy_updated`).
- **D2 — who.** An admin user (`admin` role). An API-key (`apikey:<id>`), `system` or empty identity is refused even
  when the role is present. The record's creator cannot override it, even as an admin.
- **D3 — a reason is required**, 10 to 1000 characters after trimming. It is stored on the event and on the admin
  audit entry.
- **D4 — the target must be a real step of the workflow and different from the current one.** Any step is allowed,
  including moving a record out of a terminal step: reopening is the typical use.
- **D5 — one write path.** `executeTransition`'s write half (state, event with sensitive metadata redacted at insert,
  outbox event, SLA cancel and schedule) is a shared function used by both, so they cannot drift. The outbox event is
  `workflow.transitioned` with `override: true`, so automations and connectors still see the change and can tell it apart.
- **D6 — it counts as acting.** The event is a real state change (`from_state` differs from `to_state`), so under
  `actor_not_prior_actor` an admin who overrode a step cannot then also approve it.
- **D7 — recorded twice.** The workflow event (who, why, from, to) and an admin audit entry,
  `workflow.state_overridden`, written in the same transaction as the change by the route. The entry's
  `resourceType` is the entity type's name (like the entity engine's own audit entries), so an auditor filtering
  by type finds an overridden contact as a contact. The access check, the override and the audit write share one
  transaction, so access cannot change between the check and the change.

## §R Requirements

- R1: with the switch off, an override is refused (`OVERRIDE_NOT_ENABLED`, 409) and nothing is written.
- R2: only an admin user may override; non-admins, API-key, system and empty identities are refused (`OVERRIDE_FORBIDDEN`, 403).
- R3: the creator of a record cannot override it.
- R4: a missing, blank, short or over-long reason is refused (`OVERRIDE_REASON_REQUIRED`, 422, with the bounds).
- R5: an unknown target step is refused; so is the step the record is already in (`OVERRIDE_NO_CHANGE`, 409).
- R6: a permitted override moves the record, writes the event and the outbox event (`override: true`), cancels the SLA
  timer of the step left and schedules the one entered.
- R7: it counts as acting for segregation rules.
- R8: it never crosses tenants, whatever the other tenant's switch says; a record the caller cannot see is a 404.
- R9: every use and every change of the switch is audited.

## §K Known limits

- Overriding applies to records attached to a workflow.
- **Direct state writes are refused on a workflow that uses the override or an actor rule.** `PATCH /entities/:id`,
  `POST /entities/:id/state`, `POST /entities/bulk/state` and `POST /entities` with a non-initial `currentState` answer
  `409 STATE_CHANGE_NOT_ALLOWED` (a per-item error in the bulk call) when the record's workflow has `allow_state_override`
  on or a transition whose `conditions` name an actor rule (`packages/entity-engine/src/state-write-lock.ts`). Writing the
  state the record already has is allowed. Child tickets keep their fixed open/in-progress/closed states, except that a
  child write is refused on a locked workflow when the target is also a step of the record's own workflow (a record can
  be moved under a parent, and a workflow can have a step named "closed").
  Workflows with neither keep the older direct-write path (a deliberate #127-class bypass for admin/agent); removing it
  everywhere is a separate decision, because the generic entity-type instance page still uses `POST /entities/:id/state`.
  Seeds and engine callers that create in another step leave `enforceInitialState` off and are unaffected.
- The override does not run the target step's requirements (required fields, comment): it exists to bypass the
  transition rules, and the reason is the compensating record.
- A reopened record's earlier SLA breaches are not undone.
- An override emits `workflow.transitioned` as a user action, so automations bound to the target step fire, and it
  bypasses the transition guards by design. Take that into account for approval-style workflows.
- A record with no recorded creator has no creator restriction.

## §T Tasks

| id  | task                                                                                           | req    | status |
| --- | ---------------------------------------------------------------------------------------------- | ------ | ------ |
| T1  | `allow_state_override` column, migration 0146, audit actions and enumerations                  | R9     | done   |
| T2  | Shared write half (`lockInstance`, `commitStateChange`); `overrideWorkflowState`               | R1–R7  | done   |
| T3  | `POST /entities/:id/override-state` with same-transaction audit; workflow switch and its audit | R8, R9 | done   |
| T4  | Real-Postgres tests as `app_user`, mutation-checked; route and mapping tests                   | R1–R9  | done   |
| T5  | Admin-ui: switch toggle and the override dialog                                                | R1–R9  | done   |
| T6  | Refuse direct state writes on a workflow that uses the override or an actor rule               | R1, R2 | done   |
