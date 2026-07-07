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

| constraint   | value                                                                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Entity Engine + Workflow Engine (packages/entity-engine, packages/workflow-engine); module = SQL only, zero TS in modules/                                                                                                                     |
| pattern ref  | ADR-002 (workflow-engine.md) for FSM; docs/ticket-relations-design.md + docs/specs/child-tickets.md for costing isolation                                                                                                                      |
| roles        | tender_owner, costing_lead, admin (admin = superset, all transitions)                                                                                                                                                                          |
| child ticket | reuse existing parent-child mechanism as-is — no engine changes. workflow_id=NULL, child_status open/closed only                                                                                                                               |
| out of scope | BOQ line-item entity (BOQ = single file attachment); post-submission outcome states (awarded/lost/withdrawn); submission-proof file requirement; quorum/multi-approver costing review; RLS issue #121 fix (platform-level, tracked separately) |
| perf/infra   | none beyond standard engine txn guarantees (<20ms p99 transition, per ADR-002)                                                                                                                                                                 |

## §I Interfaces

**Entity type:** `tender` — fields (all on parent entity_instances.fields JSONB unless noted):

| field                | type                     | sensitivity | required by transition                               |
| -------------------- | ------------------------ | ----------- | ---------------------------------------------------- |
| title                | text                     | internal    | draft creation                                       |
| client_name          | text                     | internal    | draft creation                                       |
| summary              | textarea                 | internal    | draft → boq_preparation                              |
| finance_details      | textarea                 | financial   | draft → boq_preparation                              |
| eligibility_criteria | textarea                 | internal    | draft → boq_preparation                              |
| certifications       | textarea                 | internal    | draft → boq_preparation                              |
| boq_file             | file_ref                 | internal    | boq_preparation → pending_costing_review             |
| costing_child_id     | entity_ref (self, child) | internal    | set by automation on entry to pending_costing_review |
| tender_documents     | file_ref                 | internal    | document_preparation → pending_submission_review     |

**Child ticket (costing sub-task):** existing mechanism, unmodified. Fields: title, assignedTo (costing_lead), dueDate, description (BOQ figures/context only — no client_name/finance_details copied in). `child_status`: open → closed, reopenable by tender_owner with comment (loop for revisions).

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

- on `workflow.transitioned` → `pending_costing_review`: create child ticket, assign to costing_lead, seed description from `boq_file` context.
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

## §V Invariants

- Child ticket never grants costing_lead visibility into parent tender record (404 on attempt, not 403) — inherited from existing child-ticket mechanism, do not weaken.
- No automation auto-transitions parent tender based on child ticket close — human review is the gate, always.
- `finance_details` and any future financial field additions must be tagged `sensitivity: financial` at creation time — never added as plain `internal`.
- Terminal state (`submitted`) has zero outgoing transitions — enforced at seed-review time, checked before merge.
- Zero TypeScript added under `modules/tender/` — config-first test applies (CLAUDE.md code-style.md).

## §T Tasks

| id  | task                                                                                         | phase | status | depends  |
| --- | -------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | `modules/tender/001_entity_types.sql` — entity_type + entity_fields (incl. sensitivity tags) | 1     | todo   | —        |
| T2  | `modules/tender/002_workflow.sql` — workflow/states/transitions per §I                       | 1     | todo   | T1       |
| T3  | `modules/tender/003_automation_rules.sql` — child ticket spawn on pending_costing_review     | 1     | todo   | T1,T2    |
| T4  | `modules/tender/004_view_configs.sql` — list/detail/form layout                              | 2     | todo   | T1       |
| T5  | `modules/tender/README.md` — module doc per new-module.md template                           | 2     | todo   | T1,T2,T3 |
| T6  | isolation test: costing_lead cannot read parent tender fields                                | 2     | todo   | T3       |
| T7  | workflow test: requires_fields gates block/pass correctly at each transition                 | 2     | todo   | T2       |
| T8  | workflow test: reject loops (costing, submission review) preserve history                    | 2     | todo   | T2       |
| T9  | register module in `modules` registry table + install flow smoke test                        | 3     | todo   | T1-T5    |

phase gate: all unit + integration tests pass before advancing to next phase; isolation suite (T6) must pass before T9 (install flow) per platform convention on tenant-sensitive data

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
