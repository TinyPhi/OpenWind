# Implementation Plan: Personal Dashboard ("My View")

**Spec:** docs/specs/personal-dashboard.md
**Generated:** 2026-08-07
**Status:** not started

---

## Phase 1 — Data & API Layer

**Goal:** shared scoping helper + `GET /api/dashboard/my-view` endpoint, fully tested (unit,
integration, isolation), no UI yet.
**Gate:** unit + integration + isolation tests pass → then Phase 2

| task                                                                                                                                           | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: extract `resolveUserScopedEntityIds(tenantId, userIds[])` from `my-tickets.ts`, update caller                                              | R1          | todo   |
| T2: build `GET /api/dashboard/my-view` — workflow breakdown sub-query + Zod response schema                                                    | R1          | todo   |
| T3: due-date sub-query (dueDates section) — live query, overdue-first/soonest sort, cap 20 + totalQualifying                                   | R2, R7      | todo   |
| T4: SLA-risk sub-query (slaRisk section) — hoursIn vs sla_hours, worst-first sort, cap 20 + totalQualifying                                    | R3, R7      | todo   |
| T5: per-section error isolation — dueDates/slaRisk sub-query failure → `unavailable:true`, HTTP 200; workflows failure → whole-request failure | R8          | todo   |
| T6: isolation tests — RLS/tenant scoping, cross-tenant negative case, cross-user negative case                                                 | R1, R2, R3  | todo   |
| T7: perf check — fixture w/ 500 scoped tickets across 10 workflows, assert <500ms                                                              | (§C perf)   | todo   |

---

## Phase 2 — Consumer Integration (Admin-UI)

**Goal:** rename existing dashboard to "Analytics", ship new `/dashboard` page for all roles,
wire drill-down navigation.
**Gate:** §R acceptance criteria met (R4–R6, R5, R8 UI-side) + Phase 1 gate still green

| task                                                                                                                                 | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T8: relabel `dashboard.tsx` nav entry to "Analytics", no logic change                                                                | R4          | todo   |
| T9: regression snapshot test — Analytics KPI values pre-/post-rename match on same fixture data                                      | R4          | todo   |
| T10: remove/relax role-based redirect-away so all roles (incl. customer) reach `/dashboard`                                          | R5          | todo   |
| T11: new `/dashboard` page — per-workflow cards (state counts), empty-card omission per R1                                           | R1          | todo   |
| T12: due-date section UI — overdue/upcoming labeling, "N more" affordance using totalQualifying                                      | R2, R7      | todo   |
| T13: SLA-risk section UI — worst-first list, "N more" affordance                                                                     | R3, R7      | todo   |
| T14: "unavailable" state UI — due-date/SLA section shows a degraded-but-non-blocking state on R8                                     | R8          | todo   |
| T15: drill-down navigation — reuse `/records`'s existing filter-param helper (no ad-hoc params), wire from state counts + list items | R6          | todo   |

---

## Phase 3 — v1.1 Widgets (no org data required)

**Goal:** four widgets using data that already exists elsewhere in the platform —
unread notifications, workflows administered, saved views, pending approvals.
**Gate:** §R acceptance criteria met (R9-R12) + Phase 1/2 gates still green

| task                                                                                                                                                                                           | requirement       | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------ |
| T16: `GET /notifications/unread-count` endpoint (tenant+user scoped `readAt IS NULL` count) + unit test                                                                                        | R9                | todo   |
| T17: `my-view` `adminWorkflows` section — workflows where `createdBy===userId` or `assignedTo` contains `userId`                                                                               | R10               | todo   |
| T18: `my-view` `savedViews` section — all of the user's saved views across entity types, tenant+user scoped                                                                                    | R11               | todo   |
| T19: `my-view` `pendingApprovals` section — pending `access_requests` joined to instance→workflow, filtered by `isWorkflowAdmin`, capped + `totalQualifying`, own try/catch (R8-style degrade) | R12               | todo   |
| T20: isolation tests for T17-T19 sections (cross-tenant, cross-user, non-admin sees nothing)                                                                                                   | R10, R11, R12     | todo   |
| T21: dashboard.tsx UI — notification bell/badge + recent list, "Workflows I administer" panel, saved-views quick-link chips, "Awaiting your approval" panel with direct drill-down             | R9, R10, R11, R12 | todo   |
| T22: empty-state handling for all four widgets (customer/non-admin users see them omitted, not erroring)                                                                                       | R10, R12          | todo   |

## Kick-Off Prompt

Copy this into your Claude Code session to start implementation:

```
Read docs/specs/personal-dashboard.md and docs/specs/personal-dashboard-tasks.md.

Implement Phase 1 tasks only (T1-T7).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass (unit + integration + isolation)
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
- resolveUserScopedEntityIds must stay array-based (§V) — do not simplify its signature
- workflows sub-query failure fails the whole request; dueDates/slaRisk failures degrade only
  their own section (R8) — do not conflate these two failure paths
```
