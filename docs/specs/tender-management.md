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

| constraint    | value                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack         | Entity Engine + Workflow Engine (packages/entity-engine, packages/workflow-engine); module = SQL only, zero TS in modules/                                                                                                                     |
| pattern ref   | ADR-002 (workflow-engine.md) for FSM; docs/ticket-relations-design.md + docs/specs/child-tickets.md for costing isolation                                                                                                                      |
| roles         | tender_owner, costing_lead, admin (admin = superset, all transitions)                                                                                                                                                                          |
| child ticket  | reuse existing parent-child mechanism as-is — no engine changes. workflow_id=NULL, child_status open/closed only                                                                                                                               |
| out of scope  | BOQ line-item entity (BOQ = single file attachment); post-submission outcome states (awarded/lost/withdrawn); submission-proof file requirement; quorum/multi-approver costing review; RLS issue #121 fix (platform-level, tracked separately) |
| perf/infra    | none beyond standard engine txn guarantees (<20ms p99 transition, per ADR-002)                                                                                                                                                                 |
| roles config  | `costing_lead` role must exist/be created in `packages/auth` role config before module install — not assumed pre-existing                                                                                                                      |
| tenant filter | issue #121 (RLS bypass) unfixed platform-wide — any future custom query for this module (beyond generated seed SQL) MUST include explicit `WHERE tenant_id = ?`, no exceptions                                                                 |

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

**Child ticket (costing sub-task):** existing mechanism, unmodified. Fields: title, assignedTo (costing_lead), dueDate, description (seeded from tender `title` + `summary` only — no client_name/finance_details/eligibility_criteria copied in; no file-content parsing). `child_status`: open → closed, reopenable by tender_owner with comment (loop for revisions). Same child reused across reject/reopen cycles — a new child is NEVER created per reopen (see §V; existing mechanism caps children per parent at 10 and this flow must never approach that cap through normal use).

Role note: child-status PATCH route (existing, `apps/api/src/routes/entities/set-child-status.ts`) allows `admin`/`agent`/`user` roles generally — not assignee-restricted — so `tender_owner` can reopen a child it doesn't own without needing to be its assignee.

**Workflow — `tender` (states, terminal marked \*):**

```
draft
  → boq_preparation                [role: tender_owner, admin] [requires_fields: summary,finance_details,eligibility_criteria,certifications]
boq_preparation
  → pending_costing_review         [role: tender_owner, admin] [requires_fields: boq_file]
pending_costing_review
  → costing_approved               [role: tender_owner, admin] [requires_comment]
  → boq_preparation (reject)       [role: tender_owner, admin] [requires_comment]
costing_approved
  → document_preparation           [role: tender_owner, admin]
document_preparation
  → pending_submission_review      [role: tender_owner, admin] [requires_fields: tender_documents]
pending_submission_review
  → submitted *                    [role: tender_owner, admin]
  → document_preparation (reject)  [role: tender_owner, admin] [requires_comment]
```

**Automation rules:**

- on `workflow.transitioned` → `pending_costing_review` (first entry only, i.e. `costing_child_id` not already set): create child ticket via existing child-relation API, assign to `costing_lead`, set description = tender `title` + `summary` text (no file parsing, no financial/eligibility fields), write resulting child id back to parent's `costing_child_id`.
- on subsequent `pending_costing_review → boq_preparation → pending_costing_review` loop: `costing_child_id` already set → automation skips creation, tender_owner reopens the existing child instead (manual action, not automated).
- (no auto-rollup — child close does NOT auto-transition parent; tender_owner reviews manually, consistent w/ existing child-ticket design's "no rollup" invariant)

## §R Requirements

R1: Tender progresses through fixed lifecycle states enforced by workflow engine, not free-form status field.
✓ Attempting a transition not defined in workflow_transitions is rejected by engine (400/422, not silently accepted)
✓ `submitted` has no outgoing transitions (terminal)

R2: Draft cannot advance to BOQ prep until summary/finance/eligibility/certification fields are filled.
✓ Transition draft→boq_preparation blocked (requires_fields violation) if any of the 4 fields empty
✓ Transition succeeds once all 4 present

R3: Costing team works a sub-task isolated from parent tender's client/financial data.
✓ Entering pending_costing_review auto-creates a child ticket assigned to costing_lead
✓ Costing_lead querying the parent tender entity gets 404 (not 403), consistent w/ existing child-ticket visibility invariant
✓ Child ticket fields contain no finance_details/client_name/eligibility_criteria values

R4: Costing rejection sends tender back for BOQ revision, not a dead end.
✓ pending_costing_review → boq_preparation transition available to tender_owner/admin
✓ requires_comment enforced (reason captured in workflow_events)

R5: Costing revision loop is achievable without new engine states — via child reopen.
✓ tender_owner can reopen a closed child ticket (child_status closed→open) with a comment
✓ Reopen + comment history visible in child ticket's activity/history tab

R6: Submission requires internal sign-off review after documents assembled.
✓ document_preparation → pending_submission_review blocked until tender_documents present
✓ pending_submission_review → submitted or → document_preparation (reject) both available to tender_owner/admin
✓ tender_owner may self-approve (no distinct approver role required in v1)

R7: Financial/eligibility data is tagged for audit redaction consistent w/ platform convention.
✓ entity_fields.sensitivity = 'financial' set on finance_details field
✓ workflow_events.metadata redacts financial-sensitivity field values per existing entity engine behavior

R8: Submission is recorded, not enforced with proof.
✓ Transition to `submitted` requires no file attachment
✓ Tender remains queryable/reportable in `submitted` terminal state
✓ `submitted_at`/`submitted_by` populated automatically on transition, no manual entry needed

R9: Costing child ticket is created automatically exactly once per tender, and reused across revision loops.
✓ First transition into pending_costing_review creates exactly one child ticket, assigned to costing_lead
✓ `costing_child_id` on parent is set to the created child's id
✓ Second/subsequent entry into pending_costing_review (after a boq_preparation reject loop) does NOT create a second child ticket
✓ Reopening the existing child (child_status closed→open) is available to tender_owner and succeeds without a role/ownership error

## §V Invariants

- Child ticket never grants costing_lead visibility into parent tender record (404 on attempt, not 403) — inherited from existing child-ticket mechanism, do not weaken.
- No automation auto-transitions parent tender based on child ticket close — human review is the gate, always.
- `finance_details` and any future financial field additions must be tagged `sensitivity: financial` at creation time — never added as plain `internal`.
- Terminal state (`submitted`) has zero outgoing transitions — enforced at seed-review time, checked before merge.
- Zero TypeScript added under `modules/tender/` — config-first test applies (CLAUDE.md code-style.md).
- Exactly one costing child ticket exists per tender at any time — reject/reopen loops reuse it, never spawn a second. If children-per-parent count for a tender ever exceeds 1, that's a bug, not a valid state.
- `tender_owner` must always be able to reopen the costing child ticket regardless of who is assigned to it — do not introduce an assignee-only restriction on the reopen path.
- Any custom query added for this module outside generated seed SQL must carry an explicit `WHERE tenant_id = ?` — RLS (issue #121) does not currently enforce this as a backstop.

## §T Tasks

| id  | task                                                                                                               | phase | status | depends  |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----- | ------ | -------- |
| T1  | `modules/tender/001_entity_types.sql` — entity_type + entity_fields (incl. sensitivity tags)                       | 1     | todo   | —        |
| T2  | `modules/tender/002_workflow.sql` — workflow/states/transitions per §I                                             | 1     | todo   | T1       |
| T3  | `modules/tender/003_automation_rules.sql` — child ticket spawn on pending_costing_review                           | 1     | todo   | T1,T2    |
| T4  | `modules/tender/004_view_configs.sql` — list/detail/form layout                                                    | 2     | todo   | T1       |
| T5  | `modules/tender/README.md` — module doc per new-module.md template                                                 | 2     | todo   | T1,T2,T3 |
| T6  | isolation test: costing_lead cannot read parent tender fields (404, no leakage) — R3                               | 2     | todo   | T3       |
| T7  | workflow test: requires_fields gates block/pass correctly at each transition — R2,R6                               | 2     | todo   | T2       |
| T8  | workflow test: reject loops (costing, submission review) preserve history — R4,R5                                  | 2     | todo   | T2       |
| T9  | automation test: child created exactly once on first entry, reused on reject/re-entry, `costing_child_id` set — R9 | 2     | todo   | T3       |
| T10 | reopen test: tender_owner (non-assignee) can flip child_status closed→open with comment — R5                       | 2     | todo   | T3       |
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
