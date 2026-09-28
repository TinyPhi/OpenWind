# Implementation Plan: Vendor Approval Module (3H Phase 1)

**Spec:** docs/specs/vendor-approval.md
**Generated:** 2026-09-27
**Status:** Phases 1–3 implemented; T12 (live walk-through) risk-accepted and tracked in #691 — see spec §B
**Issue:** #606 (tracker #613). #634 out of scope.

---

## Phase 1 — Module config

**Goal:** installable, idempotent seed-only module with role-guarded workflow.
**Gate:** T7 + T8 pass; `pnpm typecheck && pnpm lint` green.

| task                                                                                      | requirement | status |
| ----------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: package scaffold (stub index.ts only)                                                 | R1, V1      | done   |
| T2: 001_entity_types.sql                                                                  | R1, R3      | done   |
| T3: 002_workflow.sql (states, 48h SLA, role guards)                                       | R1, R2, R3  | done   |
| T4: 003_automation_rules.sql (3 disabled notify rules)                                    | R4          | done   |
| T5: 004_view_configs.sql                                                                  | R5          | done   |
| T6: seedRegistry() entry (seed-demo.ts lists no optional modules)                         | R1          | done   |
| T7: integration test — install/idempotency/not-auto-installed/role guards/required fields | R1–R3       | done   |
| T8: isolation test — cross-tenant invisibility                                            | R8          | done   |

---

## Phase 2 — Automation + auth wiring

**Goal:** notifications fire when enabled; dev stack has real department roles and users.
**Gate:** T9 passes + Phase 1 gate green.

| task                                                                                         | requirement | status |
| -------------------------------------------------------------------------------------------- | ----------- | ------ |
| T9: test — enabled notify rule creates notification on review-state entry                    | R4          | done   |
| T10: bootstrap.ts — it_security / legal / finance_approver roles + demo users (agent + role) | R6          | done   |

---

## Phase 3 — Demo + docs

**Goal:** recorded-demo-ready flow on the dev tenant using only existing UI.
**Gate:** §R met; full exit condition (typecheck, lint, test, test:isolation) green.

| task                                                                                         | requirement | status          |
| -------------------------------------------------------------------------------------------- | ----------- | --------------- |
| T11: apps/api/src/scripts/vendor-approval-demo.ts + payload fixtures via single mapping (D2) | R7          | done            |
| T12: manual E2E in docker stack, Draft → Approved across 3 role users                        | R5, R7      | deferred (#691) |
| T13: module README runbook, roadmap-tracker 3H row, week-log (issue checkboxes after merge)  | R6, R9      | done            |

---

## Kick-Off Prompt

```
Read docs/specs/vendor-approval.md and docs/specs/vendor-approval-tasks.md.

Implement Phase 1 tasks only (T1–T8).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
