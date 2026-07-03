# Implementation Plan: User-Scoped Records & Workflow Records View

**Spec:** docs/specs/user-scoped-records-view.md
**Generated:** 2026-07-02
**Status:** not started

---

## Phase 1 — API: my-tickets endpoint

**Goal:** Ship `GET /entities/my-tickets` returning scoped parent tickets, child tickets with parent-state join, and workflow rollup — all within tenant isolation.
**Gate:** Unit + integration tests pass (including cross-tenant isolation) → then Phase 2

| task                                                                                                                                                                    | requirement     | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------ |
| T1: `GET /entities/my-tickets` — query parent tickets where `created_by`, `assigned_to`, or `fields->'__accessUsers'` ? userId                                          | R1, R4          | todo   |
| T2: Extend query to include child tickets (has `__parentId`) — same three access checks, join parent row for `parentCurrentState`; exclude children of archived parents | R5, R6, R9, R10 | todo   |
| T3: Build `workflows[]` rollup from parent+child results — workflowId, name, slug, accessibleTicketCount                                                                | R2, R1          | todo   |
| T4: Register route in `apps/api/src/routes/entities/index.ts`; wire `requireAuth()`, Zod query param validation for optional `workflowId`                               | R1, R4          | todo   |
| T11: Unit tests — access list variants: creator, assigned, mention, manual; child-only access; archived parent exclusion                                                | all R           | todo   |
| T12: Integration test — cross-tenant isolation: user from tenant A cannot see tenant B tickets via my-tickets                                                           | §V invariant 1  | todo   |

---

## Phase 2 — UI: Records page

**Goal:** General user's Records page shows only workflow cards they have access to, with filter chips persisted in URL.
**Gate:** Phase 1 gate still green; Records page renders correct scoped cards in browser → then Phase 3

| task                                                                                                                                                                        | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T5: Fetch `my-tickets` (no workflowId) when `role === "user"`; derive workflow cards from `workflows[]` rollup; admin/agent path unchanged                                  | R1, R2      | todo   |
| T6: Render filter chips — All · Assigned to me · Watching · I created · Sub-tasks; active chip in URL query param `?filter=`; chips filter which workflow cards are visible | R3          | todo   |
| T6b: Workflow card shows accessible ticket count badge from `accessibleTicketCount`; card links to workflow records page carrying active `?filter=` param                   | R2, R3, R8  | todo   |

---

## Phase 3 — UI: Workflow records page

**Goal:** Kanban columns show scoped parent tickets only; each column has a sub-tasks section for accessible child tickets in that state bucket; filter chips carry through from Records page.
**Gate:** All §R acceptance criteria met; child cards link correctly; empty sub-task sections never render

| task                                                                                                                                                                                                | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T7: Role-branch in workflow records page — `role === "user"` fetches `my-tickets?workflowId=X`; admin/agent continues using existing full-list fetch                                                | R4          | todo   |
| T8: Per-column sub-tasks divider — group `childTickets` by `parentCurrentState`; render divider + child cards only when count > 0 for that column                                                   | R5, R6      | todo   |
| T9: Child ticket card component — title, status chip (open/done from child's own state field), assignee avatar, href to `/records/<entityTypeSlug>/<childId>`; no parent reference                  | R7, R9      | todo   |
| T10: Filter chips on workflow records page — read `?filter=` from URL; apply to both `parentTickets` and `childTickets` arrays client-side; sub-tasks section re-evaluates empty-check after filter | R8, R5      | todo   |

---

## Kick-Off Prompt

```
Read docs/specs/user-scoped-records-view.md and docs/specs/user-scoped-records-view-tasks.md.

Implement Phase 1 tasks only (T1, T2, T3, T4, T11, T12).

Key files to read first:
- apps/api/src/routes/entities/index.ts          (route registration pattern)
- apps/api/src/routes/entities/get-access.ts     (parseAccessUsers helper — reuse it)
- apps/api/src/routes/entities/list.ts           (existing list route — follow same pattern)
- packages/db/src/client.ts                      (withTenantContext usage)

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass (pnpm typecheck + pnpm lint + pnpm test)
- Reuse parseAccessUsers from get-access.ts — do not duplicate the JSONB parse logic
- The JSONB access check must use Drizzle's sql`` tagged template, not string concatenation (security rule)
- Admin/agent role receives no special treatment in this endpoint — it is a user-scoped endpoint only; admins use the existing list route
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and add to BLOCKERS.md
```

---

## Backprop Reminder

After each implementation session:

- If any tests failed, run `/spec amend §B` to log them.
- If a bug class emerged that could recur, run `/spec amend §V` to lock it as an invariant.
