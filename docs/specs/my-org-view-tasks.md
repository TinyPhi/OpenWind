# Implementation Plan: My Org View

**Spec:** docs/specs/my-org-view.md
**Generated:** 2026-10-22
**Status:** not started

---

## Phase 1 — Data + shared builders

**Goal:** Subtree lookup exists in org-directory, and My View's section builders are shared without changing My View's behaviour.
**Gate:** org-directory unit tests + existing `my-view.test.ts` green, unchanged → then Phase 2

| task                                                                                                                                                                                                               | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T1: `getSubtreeMembers(tenantId, userId)` in `packages/org-directory` (flatten `getReportsByLevel`; `[]` if not in tree); export; unit tests (depth, empty, absent)                                                | R1, R6      | todo   |
| T2: Extract `buildTicketsSection`/`buildDueDatesSection`/`buildSlaRiskSection`/`deriveTitle` + scoped-row fetch from `my-view.ts` into `dashboard/view-builder.ts`; `my-view.ts` imports them; no behaviour change | R3          | todo   |
| T3: `buildTeamMembersSection` + `assignedTo`/`assignedToName` on ticket items; response schemas in `dashboard/schemas.ts`                                                                                          | R7, R8      | todo   |

---

## Phase 2 — API

**Goal:** `/dashboard/org-view` and `/dashboard/team-member-view/:userId` exist, self-/subtree-scoped, isolated from My View.
**Gate:** API + isolation tests pass; Phase 1 gate still green → then Phase 3

| task                                                                                                                                                                       | requirement        | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------ |
| T4: `GET /dashboard/org-view` — JWT user only, `getSubtreeMembers` → `resolveUserScopedEntityIds([me, ...ids])` → builders → roster + names; mount in `dashboard/index.ts` | R1, R2, R5, R6, R7 | todo   |
| T5: `GET /dashboard/team-member-view/:userId` — subtree check every request, 404 on any miss, tickets only, empty personal sections; mount                                 | R9                 | todo   |
| T6: API tests — hasReports true/false/not-in-tree, any-depth scope, predicate cases, self-only, 404 matrix, My View unaffected                                             | R1–R3, R5, R9      | todo   |
| T7: Isolation test (`apps/api/tests/isolation`) — cross-tenant users/tickets never visible via either route                                                                | R10                | todo   |

---

## Phase 3 — UI + review

**Goal:** Toggle, org body, roster, team tickets and read-only view-as work in the admin UI.
**Gate:** admin-ui tests pass; `/security-review` clean; §R acceptance criteria met

| task                                                                                                                                                           | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T8: Port `dashboard-org.tsx` (`useOrgView`, `OrgDashboardBody`, roster table, team tickets) onto core's `Card`/`KpiTile`/`FilterTabs`/`Pagination`/`PAGE_SIZE` | R4, R7, R8  | todo   |
| T9: "My View / Org View" pill toggle in `dashboard.tsx` (only if `hasReports`); `/dashboard/team/:userId` route + read-only banner; roster → view-as link      | R4, R9      | todo   |
| T10: admin-ui tests — toggle visibility, single fetch across tabs, roster pagination, view-as banner/read-only                                                 | R4, R7–R9   | todo   |
| T11: `/security-review`; docs — spec status, specs README, week-log, roadmap-tracker                                                                           | all         | todo   |

---

## Kick-Off Prompt

```
Read docs/specs/my-org-view.md and docs/specs/my-org-view-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- T2 is a pure refactor: existing my-view tests must pass unmodified
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```

After any phase: log failures with `/spec amend §B`; lock recurring patterns in with `/spec amend §V`.
