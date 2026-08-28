# Implementation Plan: Third-Party API Phase E — Status Transitions

**Spec:** docs/specs/third-party-api-phase-e-status-transitions.md
**Generated:** 2026-08-25
**Status:** not started

---

## Phase 1 — Access boundary + route + audit trail

**Goal:** the transition endpoint exists, enforces the creator/assignee/workflow-admin-only gate
(never `__accessUsers`), is race-safe against a workflow deleted mid-request, and every attempt is
audit-logged — proven by the single most safety-critical test before anything else lands.
**Gate:** T4a (granted-but-not-owner rejection test) passes, plus all other Phase 1 unit/isolation
tests → then Phase 2

| task                                                                                                                                                                                                                                                                                                  | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: New narrow access-check helper in `packages/workflow-engine` (creator OR assignedTo OR `isWorkflowAdmin` — never `__accessUsers`), wrapping the internal `getWorkflow`/`isWorkflowAdmin` call in try/catch folding `WORKFLOW_NOT_FOUND` into a caller-visible "denied" result (§V race invariant) | R2          | todo   |
| T2: `POST /api/v1/tickets/:id/transitions` route — `requireAuth`+`requireActingPerson`+scope check, fetch instance (tenant-filtered, soft-delete-excluded), T1 check → 404 on deny, call `executeTransition` unmodified, map its existing 404/409/422 errors through without reshaping                | R1, R5      | todo   |
| T3: `admin_audit_log` logging on every attempt (allowed AND denied) — extend `AuditAction` union + CHECK constraint migration in the same commit (self-imposed rule from the Phase C B1 incident)                                                                                                     | R3          | todo   |
| T4a: Isolation test — a person with a `read_write` `__accessUsers` grant (not creator/assignee/admin) is rejected 404 on every transition attempt; a workflow-admin with no `__accessUsers` entry still succeeds                                                                                      | R2          | todo   |

---

## Phase 2 — Full coverage + security review

**Goal:** every remaining §R acceptance criterion has a passing test, and a dedicated security
review confirms the access boundary can't be escalated via any path this phase adds.
**Gate:** all Phase 2 tests pass + `/security-review` clean + Phase 1 gate still green → PR opens

| task                                                                                                                                                                                                                                                                                                                                      | requirement    | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| T4b: Remaining isolation tests — valid-transition success (creator/assignee/admin, 3 cases), invalid/skip-ahead rejection (422, identical body to human UI), cross-tenant/nonexistent 404 parity, exactly-one-outbox-row assertion, SLA/notification automation fires, workflow-deleted-mid-request 404 parity (proves the T1 race-guard) | R1, R3, R4, R5 | todo   |
| T5: `/security-review` (STRIDE on the access-check boundary — can a granted identity escalate via any path this phase adds?) + `/review` + docs marker + commit procedure + PR                                                                                                                                                            | all            | todo   |

phase gate: all unit + isolation tests pass, `/security-review` clean, before PR opens

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/third-party-api-phase-e-status-transitions.md and
docs/specs/third-party-api-phase-e-status-transitions-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3, T4a).

Rules:
- Do not begin Phase 2 until T4a (the granted-but-not-owner rejection test) passes —
  it is the single acceptance criterion this whole phase exists to prove.
- T1's access-check helper must wrap its getWorkflow/isWorkflowAdmin call in the same
  try/catch pattern used on the comment-post and attachment routes (§V) — this is not
  optional hardening, it closes a race that has recurred on every third-party route
  reaching isWorkflowAdmin so far.
- After each task, run relevant tests and confirm pass before continuing.
- If you hit a decision not covered by the spec, stop and ask — do not assume.
- If a test fails, run: /spec amend §B to log it before fixing.
- If the same bug class could recur, run: /spec amend §V to make it an invariant.
```
