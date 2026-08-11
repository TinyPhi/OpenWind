# Personal Dashboard ("My View")

> per-user dashboard: my-scoped ticket breakdown per workflow + due-date list + SLA-risk list. tenant-wide dashboard renamed "Analytics", admin-only.

status: draft
created: 2026-08-07
updated: 2026-08-07

---

## §G Goal

logged-in user (any role) sees own work at `/dashboard`: tickets assigned/created/watched, grouped
per workflow, w/ deadline signals (due_date + SLA). replaces current tenant-wide page as default
landing view. tenant-wide KPI page survives as "Analytics", admin-only.

designed so a future org-hierarchy rollup ("my + my subordinates' work") slots in w/o API rewrite —
org-chart itself NOT built this round (no `manager_id` exists yet).

**v1.1 (2026-08-07):** external team (AuthNexus) handed over their org-hierarchy API
contract — see memory `reference-authnexus-org-connections-api`. Org-chart integration
still deliberately deferred (explicit user instruction: "future one we will focus
later"). This revision instead adds four widgets that need no org data, using
data/tables that already exist: unread-notifications badge + recent list, "workflows I
administer," saved-views quick-links, and "awaiting your approval" (pending access
requests on workflows the user administers).

## §C Constraints

| constraint   | value                                                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Hono API (apps/api), Refine/shadcn admin-ui, Drizzle/Postgres, Zod                                                                                                                             |
| auth         | any authenticated role may access; no role-based restriction on new route/page (intentional permission-model relaxation, not an oversight — do not add a role gate later w/o a spec amendment) |
| data sources | entity_instances.assigned_to/created_by/fields.\_\_accessUsers (existing), .due_date (existing), workflow_states.sla_hours (existing) — NO schema changes                                      |
| out of scope | org-chart/manager_id impl, widget reorder/persistence, recent-activity feed, quick-action shortcuts, due_date_overdue event-history cross-ref, any workflow-engine changes                     |
| perf         | my-view endpoint responds <500ms for a user w/ up to ~500 scoped tickets across ≤10 workflows; dueDates/slaRisk lists capped at 20 rows each server-side (see R7)                              |
| tenancy      | dashboard scoped to user's current active tenant only (standard RLS/tenant_id filter) — no cross-tenant aggregation even if user belongs to multiple tenants                                   |

## §I Interfaces

`GET /api/dashboard/my-view`

- auth: requireAuth(); scope = current user's tenantId + userId
- response (Zod-validated):

```
{
  data: {
    workflows: [{
      workflowId, workflowName,
      counts: [{ stateId, stateName, count }],
      total
    }],
    dueDates: { items: [{ entityId, entityTypeName, title, dueDate, isOverdue }], totalQualifying, unavailable? },  // capped 20, sorted overdue-first then soonest
    slaRisk: { items: [{ entityId, entityTypeName, title, workflowId, stateName, hoursOver }], totalQualifying, unavailable? }  // capped 20, sorted worst-first
  }
}
```

`unavailable: true` on a section (dueDates/slaRisk only, never workflows) signals that section's
sub-query failed — response is still HTTP 200 w/ the other sections populated (see R8).

**v1.1 additions to the same response** (R9-R12 below):

```
adminWorkflows: [{ workflowId, workflowName, entityTypeId }]     // R10
savedViews: [{ id, name, entityTypeId, entityTypeName }]          // R11
pendingApprovals: { items: [{ requestId, entityId, entityTypeName, title,
  requesterId, workflowId, workflowName, requestedLevel, createdAt }],
  totalQualifying, unavailable? }                                 // R12
```

New standalone endpoint: `GET /notifications/unread-count` → `{ data: { count } }`
(R9) — separate route module (`apps/api/src/routes/notifications/`), not part of
`/dashboard/my-view`, since notifications already has its own route module and the
existing `GET /notifications?limit=N` list is reused as-is for the "recent
notifications" widget (no new list endpoint needed).

shared helper (extracted from `apps/api/src/routes/entities/my-tickets.ts`):
`resolveUserScopedEntityIds(tenantId: string, userIds: string[]): Promise<string[]>`
— takes an array (not a single id) so a future org-view can pass `[me, ...subordinateIds]`
without changing the function's contract. v1 always calls it with `[currentUserId]`.

admin-ui:

- `apps/admin-ui/src/pages/dashboard.tsx` → relabel nav entry "Analytics", keep existing
  admin-only redirect/gating logic unchanged, no behavior change.
- new page mounted at `/dashboard` (or reclaimed `/`), all roles, calls `GET /api/dashboard/my-view`.
- per-workflow cards (state counts), due-date section, SLA-risk section — fixed order, no layout persistence.
- clicking a state count or a list item navigates to `/records` pre-filtered (workflowId + stateId +
  "assigned to me"), reusing filter-chip/URL-param pattern from `docs/specs/user-scoped-records-view.md`.

## §R Requirements

R1: any authenticated user sees a per-workflow breakdown of tickets they're scoped to (assigned_to,
created_by, or in fields.\_\_accessUsers), grouped by workflow then by state.
✓ user w/ 0 scoped tickets in a workflow sees no card for that workflow (not an empty/zero card)
✓ counts match a direct DB query using the same scoping predicate as `my-tickets.ts`
✓ state names shown match `workflow_states.name` for that specific workflow (not a generic label)

R2: user sees a due-date list of their scoped tickets that have `due_date` set, overdue first then
soonest-upcoming, computed live against current time.
✓ ticket w/ due_date in the past shows in list marked overdue
✓ ticket w/ due_date in the future shows in list marked upcoming, correctly ordered by proximity
✓ ticket w/ no due_date set never appears in this list
✓ list reflects the live due_date value — no dependency on outbox/event-log history

R3: user sees an SLA-risk list of their scoped tickets, independent of due_date, computed from
time-in-current-state vs `workflow_states.sla_hours` for that state.
✓ ticket in a state w/ no sla_hours configured never appears in this list
✓ ticket whose time-in-state exceeds sla_hours appears, sorted worst-overrun first
✓ list is scoped to the requesting user only (not tenant-wide)

R4: existing tenant-wide dashboard becomes "Analytics" — same data/logic, admin-only, just relabeled.
✓ nav label reads "Analytics" for admin/agent roles
✓ non-admin roles cannot reach it (same gating as before — no regression)
✓ regression test snapshots KPI values pre- and post-rename against the same fixture data —
values must match exactly (no diff attributable to the rename)

R5: personal dashboard route is reachable by every authenticated role, incl. customers.
✓ customer-role login lands on/can navigate to `/dashboard` and sees their own scoped tickets
✓ no role is redirected away from `/dashboard`

R6: clicking a count or list item navigates to a correctly pre-filtered records view, using the
same URL filter-param shape as `/records`'s own filter chips (no ad-hoc query params).
✓ clicking a workflow's state count opens `/records` filtered to that workflow+state+assigned-to-me
✓ clicking a due-date or SLA-risk list item opens `/records` filtered to that specific entityId
✓ filter params match the existing filter-chip contract exactly — verified by reusing the same
parsing/serialization helper `/records` uses, not a parallel implementation

R7: dueDates and slaRisk lists are capped server-side so response size stays bounded regardless of
how many tickets a user is scoped to.
✓ endpoint returns at most 20 entries per list, worst/soonest first, even if >20 qualify
✓ response includes a total-qualifying-count separate from the capped array, so UI can show "N more"
✓ endpoint stays within the §C perf budget for a user w/ 500 scoped tickets across 10 workflows

R8: if the due-date or SLA-risk sub-query fails or times out, the endpoint still returns the
workflow breakdown rather than failing the whole request.
✓ simulated failure in due-date sub-query → response returns workflows + slaRisk, dueDates omitted
or marked unavailable, HTTP 200 (not 500)
✓ workflow breakdown sub-query failure is the only case that fails the whole request (it's core to R1)

R9: user sees an unread-notifications count and a short list of their most recent notifications.
✓ `GET /notifications/unread-count` returns the exact count of the user's notification_recipients
rows where `readAt IS NULL`, tenant+user scoped
✓ recent-notifications widget reuses the existing `GET /notifications?limit=N` endpoint unchanged —
no new list endpoint
✓ marking a notification read (existing mark-read endpoint) and re-fetching unread-count reflects
the decrement

R10: a user who administers one or more workflows (workflow `createdBy` or in `assignedTo`) sees
a distinct "workflows I administer" list.
✓ list includes a workflow only when `createdBy === userId` or `assignedTo` contains `userId`
✓ user who administers zero workflows sees an empty list, not an error (same empty-state rule as R1)
✓ list is tenant-scoped — never includes another tenant's workflows

R11: user sees their saved views (`saved_views` table) as quick-link entries, across all entity
types they've saved a view for (not scoped to one entity type like the existing
`GET /saved-views?entityTypeId=` route).
✓ every saved view row owned by `(tenantId, userId)` appears, regardless of entity type
✓ user with no saved views sees an empty list, not an error

R12: a workflow admin sees pending access requests awaiting their approval, across every workflow
they administer — not just one ticket at a time (unlike the existing per-instance
`GET /entities/:id/access-requests` route).
✓ a pending `access_requests` row appears here only if the requesting user administers the
workflow that owns the request's ticket (same `isWorkflowAdmin` check the existing per-instance
route already uses — no new authorization logic invented)
✓ approved/rejected requests never appear (status filter is `pending` only)
✓ this section follows the same partial-failure rule as R8 — its own sub-query failing degrades
only this section, never the rest of the response
✓ capped + `totalQualifying`, same pattern as R7

## §V Invariants

- due_date and sla_hours are separate signals, never merged into one score (per due-date.md's
  explicit separation of system-level due_date from state-derived, ephemeral sla_hours).
- personal dashboard query scoping must always match `my-tickets.ts`'s predicate exactly (single
  source of truth via the shared `resolveUserScopedEntityIds` helper) — no parallel/divergent
  scoping logic in the new endpoint.
- `resolveUserScopedEntityIds` signature stays array-based even though v1 always passes one id —
  do not simplify to a single-id signature, org-view depends on this shape.
- RLS/tenant scoping applies to the new endpoint same as every other tenant-scoped query (explicit
  tenant_id filter, per db-conventions.md).
- any list/widget added to this dashboard in future follows R1's empty-state rule: zero qualifying
  items means the section/card is omitted, never rendered as an empty placeholder.
- dashboard drill-down links always reuse `/records`'s existing filter-param contract — never a
  second, ad-hoc query-param scheme (see R6).
- a sub-query failure for a non-core section (due-date, SLA-risk, pendingApprovals) degrades that
  section only; it never fails the whole `my-view` response (see R8) — workflow breakdown (R1) is
  the only section treated as request-critical.
- `pendingApprovals`' authorization reuses `isWorkflowAdmin` from `@platform/workflow-engine`
  verbatim — no parallel admin-check implementation (mirrors the R1/my-tickets.ts single-source-
  of-truth rule for the analogous case).
- org-chart integration (AuthNexus API, see memory `reference-authnexus-org-connections-api`)
  remains explicitly deferred — do not start it without a fresh go-ahead, even though the API
  contract is now known.

## §T Tasks

full breakdown in `docs/specs/personal-dashboard-tasks.md` (T1-T22, 3 phases). summary:

| id      | task                                                                                                                          | phase | status | depends |
| ------- | ----------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1-T7   | data & API layer: scoping helper, my-view endpoint (workflows/dueDates/slaRisk), error isolation, isolation tests, perf check | 1     | todo   | —       |
| T8-T15  | consumer integration: Analytics rename+snapshot test, redirect removal, new dashboard page, drill-down nav                    | 2     | todo   | T1-T7   |
| T16-T22 | v1.1 widgets: unread-notifications endpoint, adminWorkflows/savedViews/pendingApprovals sections, UI widgets                  | 3     | todo   | T8-T15  |
| open    | decide: org-chart data source (manager_id column vs IdP) — deferred, informational only, not a phase gate                     | —     | open   | —       |

phase gate: all unit + integration + isolation tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
