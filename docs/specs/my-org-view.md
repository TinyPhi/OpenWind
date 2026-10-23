# My Org View

> Manager rollup of tickets across a user's whole org-directory subtree, as a second tab on the personal dashboard. For any user with people below them in the org chart.

status: in-progress
created: 2026-10-22
updated: 2026-10-22

Port of the AuthNexus fork's `docs/specs/my-org-view.md` (worktree `nexus-OW`, branch `new`), re-based on
this codebase's own org tree (`docs/specs/org-directory.md`). Selective port, not a merge: core's
`my-view.ts` / `dashboard.tsx` have diverged from the fork's.

---

## §G Goal

User with ≥1 report in the org tree sees, next to My View, an Org View of their own + every direct/indirect
report's tickets: workload, due dates, SLA risk, per-person roster, team ticket list. From the roster they
can open any report's dashboard read-only. Gated only on having reports — never on role.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack        | Hono API (`apps/api`), React admin-ui (`apps/admin-ui`), `@platform/org-directory` query API (Postgres `org_employees`)                                                                                                  |
| data source  | org-directory tree only. No AuthNexus, no external call, no bearer forwarding, no retry/unavailable machinery. Reads never depend on Zitadel (org-directory §V)                                                          |
| identity     | tree node `userId` = Zitadel `sub` = JWT `userId`. Names (`OrgNode.name`) come from the tree                                                                                                                             |
| ticket scope | existing `buildUserScopeFilter` / `resolveUserScopedEntityIds` (`apps/api/src/routes/entities/scoped-access.ts`): creator, assignee, `__accessUsers`. Predicate unchanged — only the id list grows to `[me, ...subtree]` |
| auth         | `requireAuth()` only, no `requireRole()`. Tenant from `c.get("auth")`                                                                                                                                                    |
| out of scope | `workflows.admin_only` / `isGlobalAdmin` (fork-only feature, no column here, no migration); AuthNexus types; matrix/dotted-line reporting; push updates; viewing anyone's _org_ view but your own; role-gating; edits    |

## §I Interfaces

```
GET /dashboard/org-view                      (apps/api/src/routes/dashboard/org-view.ts)
  auth: requireAuth(); target user = c.get("auth").userId, never a param
  200 { data: {
          hasReports: boolean,
          workflows[], tickets{items,totalQualifying}, dueDates{...}, slaRisk{...},   // same shapes as /dashboard/my-view
          teamMembers{ items: [{ userId, name, ticketCount, overdueCount }] }          // one row per report, never self
        } }
  hasReports=false → all sections empty; frontend hides toggle
  tickets.items[] += assignedTo, assignedToName (name from tree, falls back to raw id)

GET /dashboard/team-member-view/:userId      (apps/api/src/routes/dashboard/team-member-view.ts)
  auth: requireAuth(); :userId must be in caller's subtree (verified every request) else 404
  200 { data: { targetUser{userId,name}, workflows, tickets, dueDates, slaRisk,
                adminWorkflows: [], savedViews: [], pendingApprovals: {items:[],totalQualifying:0} } }

org-directory (packages/org-directory, new export, same package, no new dependency edge):
  getSubtreeMembers(tenantId, userId) → { ids: string[], members: OrgNode[] }   // all levels flattened, excl. self
    built on getReportsByLevel; [] when userId not in tree

admin-ui:
  /dashboard                  My View | 👥 Org View pill toggle (toggle only if hasReports)
  /dashboard/team/:userId     Dashboard rendered read-only from team-member-view (banner: "Viewing <name>")
```

## §R Requirements

R1: Org View gated only on having reports.
✓ user with 0 reports, any role incl. admin → `hasReports:false`, toggle hidden
✓ user with ≥1 report, any role incl. admin/customer → toggle shown, route works
✓ user absent from the tree (never synced) → `hasReports:false`, no error

R2: Org View scopes tickets with the existing predicate over self + whole subtree.
✓ `resolveUserScopedEntityIds` / `buildUserScopeFilter` reused, no new predicate
✓ ticket included iff creator, assignee or `__accessUsers` member ∈ `[me, ...all descendants]` at any depth
✓ ticket created by a report but assigned outside the subtree still included; ticket of someone outside the subtree and unrelated to it never included
✓ DASHBOARD_SCOPE_LIMIT (2000) bound applies

R3: Org View failure never affects My View.
✓ `GET /dashboard/my-view` unchanged in behaviour/response whether or not org-view works
✓ org-view handler errors → typed error response (handleEntityError pattern), no shared failure surface
✓ org-view degrades per-section (tickets/dueDates/slaRisk) like My View

R4: Toggle, not a merged page.
✓ My View UI has no org-aware code paths besides the toggle + `useOrgView` probe
✓ switching tabs reuses one `/dashboard/org-view` fetch (no second request)
✓ toggle absent while viewing-as a subordinate

R5: Self-only target.
✓ org-view takes no userId from client; always JWT `userId`
✓ no route/param exists to fetch another user's org view

R6: Subtree = every level below the caller.
✓ direct report, report-of-report, deeper — all included
✓ caller never in `teamMembers`; caller's own tickets still in the scoped set
✓ cycle-broken / reparented nodes (org-directory R4/R5) appear exactly once

R7: Team roster.
✓ one row per subtree member: `ticketCount` = scoped tickets with `assignedTo` = member; `overdueCount` = those with due date < now
✓ name from the tree; row never dropped
✓ roster paginated in UI

R8: Team tickets list.
✓ flat list of scoped tickets with `assignedToName`; paginated; same filter tabs as My View
✓ capped like My View's tickets list

R9: View as subordinate (read-only).
✓ target must be in caller's subtree (any depth), checked against the tree on every request; otherwise 404 (not 403)
✓ returns only ticket sections; adminWorkflows/savedViews/pendingApprovals always empty
✓ no mutating route exists under `/dashboard/team/*`; UI shows banner and no actions that edit the report's personal workspace
✓ unknown userId, non-subtree userId, self, cross-tenant id → identical 404

R10: Tenant isolation.
✓ all ticket queries tenant-scoped (`withTenantContext` + explicit `tenant_id`); tree read by `auth.tenantId`
✓ a user id from another tenant never resolves (404)

R11: Freshness.
✓ tree changes after an org-directory sync appear on next request (no stale per-process cache). Read-per-request is acceptable at current org sizes

## §V Invariants

- Org-view target userId is ALWAYS server-verified JWT `userId`. No client-supplied target for `/org-view`. (R5)
- `/team-member-view/:userId` trusts nothing from the URL: re-verifies subtree membership on every request, 404 on any miss. Fail closed. (R9)
- Org-view failures never block, delay or crash `/dashboard/my-view`. (R3)
- Ticket predicate lives only in `scoped-access.ts`; org view adds ids, never conditions. (R2)
- Org view reads only this platform's own tables (org-directory); never Zitadel at request time. (§C)
- Cross-tenant or non-subtree access → 404, never 403 (code-style: 403 leaks existence). (R9, R10)
- No `isGlobalAdmin`/`adminOnly` plumbing added to `scoped-access.ts` or the dashboard (not ported).

## §T Tasks

| id  | task                                                                                                                                                                                                                                     | phase | status                   | depends   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------ | --------- |
| T1  | `getSubtreeMembers(tenantId, userId)` in `packages/org-directory` (flatten `getReportsByLevel`; [] if absent) + unit tests (depth, empty, not-in-tree)                                                                                   | 1     | done                     | —         |
| T2  | Extract My View's section builders (`buildTicketsSection`/`buildDueDatesSection`/`buildSlaRiskSection`, `deriveTitle`, row fetch) into `dashboard/view-builder.ts`; `my-view.ts` imports them, behaviour unchanged, existing tests green | 1     | done                     | —         |
| T3  | `buildTeamMembersSection(rows, memberIds, now)` (assignedTo counts) + `assignedTo`/`assignedToName` on ticket items; schemas in `dashboard/schemas.ts`                                                                                   | 1     | done                     | T2        |
| T4  | `GET /dashboard/org-view` (self-scoped, `getSubtreeMembers` → scope helper → builders → roster + names) + mount in `dashboard/index.ts`                                                                                                  | 2     | done                     | T1,T3     |
| T5  | `GET /dashboard/team-member-view/:userId` (subtree check per request, tickets only, empty personal sections) + mount                                                                                                                     | 2     | done                     | T1,T3     |
| T6  | API tests: hasReports true/false/not-in-tree, any-depth scope, predicate cases (R2), self-only, 404 matrix (R9), My View unaffected (R3)                                                                                                 | 2     | done                     | T4,T5     |
| T7  | Isolation test (`apps/api/tests/isolation`): tenant A user cannot see tenant B tickets/ids via either route; RLS on org read                                                                                                             | 2     | written, not run locally | T4,T5     |
| T8  | admin-ui: port `dashboard-org.tsx` (`useOrgView`, `OrgDashboardBody`, roster table, team tickets) onto core's `Card`/`KpiTile`/`FilterTabs`/`Pagination`/`PAGE_SIZE`                                                                     | 3     | done                     | T4        |
| T9  | admin-ui: "My View / Org View" pill toggle in `dashboard.tsx` (only if `hasReports`), `/dashboard/team/:userId` route + read-only banner, roster → view-as link                                                                          | 3     | done                     | T5,T8     |
| T10 | admin-ui tests (toggle visibility, tab switch single fetch, roster pagination, view-as banner/read-only)                                                                                                                                 | 3     | done                     | T8,T9     |
| T11 | `/security-review` (new read path over other users' tickets) + docs: spec status, specs README row, week-log, roadmap-tracker                                                                                                            | 3     | in progress              | T6,T7,T10 |

phase gate: all unit + integration tests pass before advancing to next phase

Open items (decide before/while building):

| id  | item                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | `getReportsByLevel` loads every tenant row per call. Fine for tens/hundreds of people; add a short per-tenant cache or recursive CTE if orgs grow to thousands                                      |
| O2  | Sandbox admin is a manager in the seeded tree → sees the toggle with an Engineering-only subtree (not "all tickets"). Accepted per decision; revisit if it confuses demos                           |
| O3  | Manager sees subtree tickets regardless of normal sharing (R2). Confirm no ticket type needs exclusion (e.g. HR/reimbursement) — would need a per-workflow flag, i.e. a separate feature            |
| O4  | `/dashboard/team/:userId` reuses `Dashboard` (fork approach); confirm core's `dashboard.tsx` (1850 lines, diverged) can take a `viewAs` prop without disturbing the v1.1 sections                   |
| O5  | `OrgNode.name` falls back to raw id? Tree always has a name (`org_employees.name` not null); fallback only matters for a stale id                                                                   |
| O6  | The roster counts and totals come from at most 2,000 scoped tickets (newest first), so a very large org's per-person counts are undercounted. Raise the cap or count in SQL if orgs reach that size |

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
| —   | —           | —          | —               |

---

_spec is source of truth — update as decisions are made_
