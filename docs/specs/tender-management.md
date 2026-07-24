# Tender Management Module

> Config-only module (seed SQL, no TS) digitizing the tender team's lifecycle: draft → BOQ → costing review (isolated via child ticket) → doc prep → submission review → submitted.

status: draft
created: 2026-07-07
updated: 2026-07-07

---

## §G Goal

Tender team runs full tender lifecycle inside platform instead of offline/manual tracking.
Costing team works isolated sub-task (child ticket) w/o visibility into parent tender's financial/client fields.
Every stage gated by role + required fields; full audit trail via workflow_events + child ticket history.

## §C Constraints

| constraint    | value                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack         | Entity Engine + Workflow Engine (packages/entity-engine, packages/workflow-engine); module = SQL only, zero TS in modules/                                                                                                                                                                                                                                    |
| pattern ref   | ADR-002 (workflow-engine.md) for FSM; docs/ticket-relations-design.md + docs/specs/child-tickets.md for costing isolation                                                                                                                                                                                                                                     |
| roles         | Global roles are `agent` and `admin` only (from Zitadel claims) — no custom module roles exist. All tender transitions gated by `allowed_roles: [agent, admin]`. No `tender_owner`/`costing_lead` role — "owner" is whoever is `assignedTo` on the tender, same convention as other tickets.                                                                  |
| child ticket  | reuse existing parent-child mechanism as-is — no engine changes. workflow_id=NULL, child_status open/closed only                                                                                                                                                                                                                                              |
| out of scope  | BOQ line-item entity (BOQ = single file attachment); post-submission outcome states (awarded/lost/withdrawn); submission-proof file requirement; quorum/multi-approver costing review; RLS issue #121 fix (platform-level, tracked separately — since fixed via PR #135, `withTenantContext` now sets `SET LOCAL ROLE app_user` so RLS fires unconditionally) |
| perf/infra    | none beyond standard engine txn guarantees (<20ms p99 transition, per ADR-002)                                                                                                                                                                                                                                                                                |
| roles config  | None required — `agent`/`admin` already exist platform-wide. Costing isolation uses `assignedTo` on the child ticket, not a role, so no new role needs to be created anywhere.                                                                                                                                                                                |
| tenant filter | RLS now enforces this as a real backstop (issue #121 closed via PR #135) — but explicit `WHERE tenant_id = ?` is still MANDATORY on any future custom query for this module (beyond generated seed SQL), as defense-in-depth, not as a workaround for a bypass that no longer exists                                                                          |

## §I Interfaces

**Entity type:** `tender` — fields (all on parent entity_instances.fields JSONB unless noted):

| field                | type                     | sensitivity | required by transition                                                                 |
| -------------------- | ------------------------ | ----------- | -------------------------------------------------------------------------------------- |
| title                | text                     | internal    | draft creation                                                                         |
| client_name          | text                     | internal    | draft creation                                                                         |
| summary              | textarea                 | internal    | draft → boq_preparation                                                                |
| finance_details      | textarea                 | financial   | draft → boq_preparation                                                                |
| eligibility_criteria | textarea                 | internal    | draft → boq_preparation                                                                |
| certifications       | textarea                 | internal    | draft → boq_preparation                                                                |
| boq_file             | file_ref                 | internal    | boq_preparation → pending_costing_review                                               |
| costing_child_id     | entity_ref (self, child) | internal    | written by automation action on entry to pending_costing_review (see Automation rules) |
| tender_documents     | file_ref                 | internal    | document_preparation → pending_submission_review                                       |
| submitted_at         | datetime                 | internal    | written by engine on transition to submitted                                           |
| submitted_by         | user_ref                 | internal    | written by engine on transition to submitted                                           |

**Child ticket (costing sub-task):** existing mechanism, unmodified. Fields: title, assignedTo (the costing analyst — any user, no role requirement), dueDate, description (seeded from tender `title` + `summary` only — no client_name/finance_details/eligibility_criteria copied in; no file-content parsing). `child_status`: open → closed, reopenable by the tender's agent with comment (loop for revisions). Same child reused across reject/reopen cycles — a new child is NEVER created per reopen (see §V; existing mechanism caps children per parent at 10 and this flow must never approach that cap through normal use).

Isolation note: the costing analyst does not need any special role — access to the costing sub-task is entirely via being `assignedTo` the child ticket (existing `canUserReadInstance` ancestor-walk logic, `packages/entity-engine/src/child-relations.ts`), which is also what keeps them from seeing the parent tender (404, not 403). This holds whether the costing analyst is a plain user or has the `agent` role.

Role note: child-status PATCH route (existing, `apps/api/src/routes/entities/set-child-status.ts`) allows `admin`/`agent`/`user` roles generally — not assignee-restricted — so the tender's agent can reopen a child ticket without needing to be its assignee.

Known engine gap: workflow transition guards (`packages/workflow-engine/src/engine.ts::executeTransition`) check `allowed_roles` against the actor's global roles only — they do NOT consult `__accessUsers`/per-instance grants. So "any agent or admin" can transition any tender in this module, not just the one assigned to it. Narrowing that would require an engine-level change (out of scope, see §C) — accepted as a v1 limitation, not fixed here.

**Workflow — `tender` (states, terminal marked \*):**

```
draft
  → boq_preparation                [role: agent, admin] [requires_fields: summary,finance_details,eligibility_criteria,certifications]
boq_preparation
  → pending_costing_review         [role: agent, admin] [requires_fields: boq_file]
pending_costing_review
  → costing_approved               [role: agent, admin] [requires_comment]
  → boq_preparation (reject)       [role: agent, admin] [requires_comment]
costing_approved
  → document_preparation           [role: agent, admin]
document_preparation
  → pending_submission_review      [role: agent, admin] [requires_fields: tender_documents]
pending_submission_review
  → submitted *                    [role: agent, admin]
  → document_preparation (reject)  [role: agent, admin] [requires_comment]
```

**Automation rules:**

- on `workflow.transitioned` → `pending_costing_review` (first entry only, i.e. `costing_child_id` not already set): create child ticket via existing child-relation API, assign to a costing analyst (specific user, chosen manually at creation time — no role lookup, since no "costing_lead" role exists), set description = tender `title` + `summary` text (no file parsing, no financial/eligibility fields), write resulting child id back to parent's `costing_child_id`.
- on subsequent `pending_costing_review → boq_preparation → pending_costing_review` loop: `costing_child_id` already set → automation skips creation, the tender's agent reopens the existing child instead (manual action, not automated).
- (no auto-rollup — child close does NOT auto-transition parent; the tender's agent reviews manually, consistent w/ existing child-ticket design's "no rollup" invariant)

## §R Requirements

R1: Tender progresses through fixed lifecycle states enforced by workflow engine, not free-form status field.
✓ Attempting a transition not defined in workflow_transitions is rejected by engine (400/422, not silently accepted)
✓ `submitted` has no outgoing transitions (terminal)

R2: Draft cannot advance to BOQ prep until summary/finance/eligibility/certification fields are filled.
✓ Transition draft→boq_preparation blocked (requires_fields violation) if any of the 4 fields empty
✓ Transition succeeds once all 4 present

R3: Costing team works a sub-task isolated from parent tender's client/financial data.
✓ Entering pending_costing_review auto-creates a child ticket assigned to a specific costing analyst user
✓ That user querying the parent tender entity gets 404 (not 403), consistent w/ existing child-ticket visibility invariant
✓ Child ticket fields contain no finance_details/client_name/eligibility_criteria values
✓ Isolation holds regardless of the costing analyst's global role (agent or no role) — enforced via assignedTo, not a role check

R4: Costing rejection sends tender back for BOQ revision, not a dead end.
✓ pending_costing_review → boq_preparation transition available to agent/admin
✓ requires_comment enforced (reason captured in workflow_events)

R5: Costing revision loop is achievable without new engine states — via child reopen.
✓ Any agent/admin (not just the child's assignee) can reopen a closed child ticket (child_status closed→open) with a comment
✓ Reopen + comment history visible in child ticket's activity/history tab

R6: Submission requires internal sign-off review after documents assembled.
✓ document_preparation → pending_submission_review blocked until tender_documents present
✓ pending_submission_review → submitted or → document_preparation (reject) both available to agent/admin
✓ Same agent who assembled documents may self-approve (no distinct approver role in v1)

R7: Financial/eligibility data is tagged for audit redaction consistent w/ platform convention.
✓ entity_fields.sensitivity = 'financial' set on finance_details field
✓ workflow_events.metadata redacts financial-sensitivity field values per existing entity engine behavior

R8: Submission is recorded, not enforced with proof.
✓ Transition to `submitted` requires no file attachment
✓ Tender remains queryable/reportable in `submitted` terminal state
✓ `submitted_at`/`submitted_by` populated automatically on transition, no manual entry needed

R9: Costing child ticket is created automatically exactly once per tender, and reused across revision loops.
✓ First transition into pending_costing_review creates exactly one child ticket, assigned to a specific costing analyst user
✓ `costing_child_id` on parent is set to the created child's id
✓ Second/subsequent entry into pending_costing_review (after a boq_preparation reject loop) does NOT create a second child ticket
✓ Reopening the existing child (child_status closed→open) is available to any agent/admin and succeeds without a role/ownership error

R10: No workflow transition relies on a role that doesn't exist in the platform's auth system.
✓ Every `allowed_roles` entry across all tender_workflow transitions is one of exactly `agent`, `admin` — verified by reading `002_workflow.sql` back, not by assumption
✓ No entity_fields/config value or automation rule references `tender_owner`/`costing_lead` as a role string anywhere

## §V Invariants

- Child ticket never grants its assignee visibility into the parent tender record (404 on attempt, not 403) — inherited from existing child-ticket mechanism, do not weaken.
- No automation auto-transitions parent tender based on child ticket close — human review is the gate, always.
- `finance_details` and any future financial field additions must be tagged `sensitivity: financial` at creation time — never added as plain `internal`.
- Terminal state (`submitted`) has zero outgoing transitions — enforced at seed-review time, checked before merge.
- Zero TypeScript added under `modules/tender/` — config-first test applies (CLAUDE.md code-style.md).
- Exactly one costing child ticket exists per tender at any time — reject/reopen loops reuse it, never spawn a second. If children-per-parent count for a tender ever exceeds 1, that's a bug, not a valid state.
- Any `agent`/`admin` must always be able to reopen the costing child ticket regardless of who is assigned to it — do not introduce an assignee-only restriction on the reopen path.
- Only `agent` and `admin` (the platform's actual global roles) ever appear in this module's `allowed_roles` arrays — never a module-invented role name. If a future requirement needs finer-grained gating, it goes through `entity_instances.fields.__accessUsers` + an engine-level transition-guard change, not a new role string.
- Any custom query added for this module outside generated seed SQL must carry an explicit `WHERE tenant_id = ?` — RLS now enforces this as a real second layer too (issue #121 closed via PR #135), but the explicit filter remains mandatory as defense-in-depth (per `db-conventions.md`), never removed on the assumption RLS alone is sufficient.

## §T Tasks

| id  | task                                                                                                               | phase | status | depends  |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----- | ------ | -------- |
| T1  | `modules/tender/001_entity_types.sql` — entity_type + entity_fields (incl. sensitivity tags)                       | 1     | todo   | —        |
| T2  | `modules/tender/002_workflow.sql` — workflow/states/transitions per §I                                             | 1     | todo   | T1       |
| T3  | `modules/tender/003_automation_rules.sql` — child ticket spawn on pending_costing_review                           | 1     | todo   | T1,T2    |
| T4  | `modules/tender/004_view_configs.sql` — list/detail/form layout                                                    | 2     | todo   | T1       |
| T5  | `modules/tender/README.md` — module doc per new-module.md template                                                 | 2     | todo   | T1,T2,T3 |
| T6  | isolation test: costing analyst (child assignee) cannot read parent tender fields (404, no leakage) — R3           | 2     | todo   | T3       |
| T7  | workflow test: requires_fields gates block/pass correctly at each transition — R2,R6                               | 2     | todo   | T2       |
| T8  | workflow test: reject loops (costing, submission review) preserve history — R4,R5                                  | 2     | todo   | T2       |
| T9  | automation test: child created exactly once on first entry, reused on reject/re-entry, `costing_child_id` set — R9 | 2     | todo   | T3       |
| T10 | reopen test: agent (non-assignee) can flip child_status closed→open with comment — R5                              | 2     | todo   | T3       |
| T14 | audit task: grep seed SQL for any role string other than agent/admin — R10                                         | 1     | todo   | T2,T3    |
| T11 | redaction test: financial-sensitivity fields masked in workflow_events.metadata — R7                               | 2     | todo   | T1,T2    |
| T12 | submission test: transition to `submitted` succeeds with no file, sets submitted_at/by — R8                        | 2     | todo   | T2       |
| T13 | register module in `modules` registry table + install flow smoke test                                              | 3     | todo   | T1-T12   |

phase gate: all unit + integration tests pass before advancing to next phase; isolation suite (T6) and automation suite (T9) must pass before T13 (install flow) per platform convention on tenant-sensitive data

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
