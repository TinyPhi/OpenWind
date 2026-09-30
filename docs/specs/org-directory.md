# Org Directory

> Visible org-chart module for OpenWind — seeded once from auth-provider (Zitadel) user
> metadata, then lives entirely in OpenWind's own tenant-scoped tables so viewing/querying it
> never depends on the auth provider being up or even still being Zitadel.

status: draft
created: 2026-09-29
updated: 2026-09-29

---

## §G Goal

- Every tenant has one browsable org-chart page: single root ("Company Name" card) → real
  employees fanned out below by manager relationship.
- Chart is populated by pulling `manager_id` + `department` from the auth provider's per-user
  metadata (auto on first boot, admin-triggered, and every 24h) — never read live per-request.
- Any engine (workflow/automation, later) can ask "who's above this person" or "who reports to
  this person, by level" via a stable internal interface — without touching the auth provider.

## §C Constraints

| constraint            | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack                 | Hono API route, Drizzle+Postgres (RLS), Refine/shadcn admin-ui, plain package (packages/org-directory) like packages/teams — not an entity-engine module                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| auth                  | Zitadel service-account (existing `packages/auth/src/zitadel-management.ts` pattern) for the importer only; page itself uses normal session auth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| tenancy               | 1 org tree per tenant; RLS + explicit `tenant_id` filter on every query (ADR-001)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| out of scope          | manual edits to manager/department inside OpenWind (all edits happen in Zitadel; OpenWind is read-only mirror); dotted-line / multi-manager reporting; org chart for entities other than employees (no team/service nodes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| perf                  | chart interactive within 200ms for a synced tree of ≤500 employees at depth-3 default expand                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| new package/module    | `packages/org-directory` for tree-build/storage/query — plain Drizzle-managed tables, **not** an entity-engine module. Corrected during implementation: `modules/teams` doesn't exist either — teams/services/on-call are plain tables per ADR-016 Decision 1 ("on-call lookup is a hot path, must be a single indexed query, not a JSONB traversal"), the same reasoning that applies to org-directory's R10 chain/report queries. No `modules/org-directory` entry, no `entity_types` registration, no ADR-004 dependency. **Decided (resolves prior T1 open item):** own package, not an extension of `packages/teams` — `teams → db only` per CLAUDE.md's dependency graph, but the sync path needs `packages/auth` (for the Zitadel service-account/importer calls), which `teams` must never depend on. `packages/org-directory` depends only on `db` + `auth`; it does not import from or depend on `packages/teams`. |
| root identity         | root card's display name = `tenants.name` (existing column, `packages/db/src/schema/platform.ts:21`) for the tenant being synced — no new tenant-name field needed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| metadata key contract | importer reads exactly two Zitadel user-metadata keys, case-sensitive: `manager_id` (string, Zitadel userId of the manager) and `department` (string, free text). Any other/misspelled key is ignored, not partially matched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| sync concurrency      | at most one sync (auto or manual) may run per tenant at a time; a `triggerSync` call while one is already in flight for that tenant returns the in-flight run's status rather than starting a second (see R2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| sync atomicity        | a sync run's tree rebuild is atomic — either the whole new tree replaces the old one, or (on any failure) nothing changes and the prior tree remains fully intact (see R2, R5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## §I Interfaces

Internal query interface (consumed by other engines later, e.g. automation-engine approval
routing):

```
getChainToRoot(tenantId, userId): OrgNode[]      // userId -> ... -> root, inclusive, ordered bottom-up
getReportsByLevel(tenantId, userId): OrgNode[][]  // index 0 = direct reports, index 1 = their reports, ...
getOrgTree(tenantId): OrgTree                     // full tree for page render
triggerSync(tenantId, actorUserId): SyncResult    // admin-only, manual re-import
getSyncStatus(tenantId): { lastSyncedAt, lastSyncOk, staleSinceMs, syncInProgress }
```

`lastSyncedAt`/`staleSinceMs` refer to the last _successful_ sync, not the last attempt —
`lastSyncOk` separately reports whether the most recent attempt (successful or not) failed, so
the UI can render "last synced 3h ago" alongside a distinct "last sync attempt failed" flag
when those two diverge. A `triggerSync` call made while `syncInProgress` is already true
returns `{ status: "already_running", ...currentRunStatus }` rather than a normal `SyncResult`,
so the admin-ui can distinguish "I just started a new sync" from "one was already running."

`OrgNode`: `{ userId, parentId | null, name, title, department, email, isRoot }` — `parentId` is
always present except on the root node itself, so both a flat list (parentId-based) and a
nested tree can be derived from the same shape.

`OrgTree`: `{ root: OrgNode, nodesByParentId: Record<userId, OrgNode[]> }` — flat map keyed by
parent, not a deeply-nested object, so the UI can lazily materialize children per expand-click
(R8's depth-3-default / expand-on-demand) without walking/serializing the whole nested structure
up front.

Importer boundary (the ONLY code allowed to call the auth provider):

```
OrgSourceImporter.fetchAll(tenantId): Array<{
  userId, managerId: string | null, department: string | null, name, title, email
}>
```

Today's implementation = `ZitadelOrgSourceImporter` (wraps `listOrgUsers` + a new metadata read
for the exact keys `manager_id`/`department` in `packages/auth`, reusing that package's existing
per-tenant caching/single-flight pattern — see `_usersCache` in `zitadel-management.ts` — so a
multi-tenant 24h sync fan-out doesn't hammer Zitadel with redundant calls). A future provider
swap or a future external org-chart service only requires a new `OrgSourceImporter`
implementation — `packages/org-directory`'s tree-build, storage, and query logic never change.

## §R Requirements

R1: Org tree is stored in OpenWind's own DB, keyed per tenant, independent of auth-provider
availability at read time.
✓ Page renders correctly with auth provider fully unreachable, as long as a prior successful sync exists.
✓ `getChainToRoot`/`getReportsByLevel` never make a network call to the auth provider.

R2: Sync (import) pulls the `manager_id` + `department` metadata keys (+ name/title/email
already available via existing `listOrgUsers`) from the auth provider and rebuilds the
tenant's tree.
✓ Runs automatically on first container boot per tenant (if no tree exists yet).
✓ Runs automatically every 24h per tenant.
✓ Admin can trigger `triggerSync` on demand; non-admin request is rejected (403 — same-tenant
member, so no cross-tenant existence leak to reason about here).
✓ A second `triggerSync`/scheduled-sync attempt for a tenant that already has one in flight
does not start a concurrent rebuild — it returns the in-flight run's status.
✓ A sync's tree rebuild is atomic: consumers (`getOrgTree`, `getChainToRoot`,
`getReportsByLevel`) never observe a partially-rebuilt tree — either the full new tree is
visible, or the prior tree still is.
✓ A failed sync (including a partial failure mid-rebuild) leaves the previously-built tree
fully intact and queryable; failure is logged and reflected in `getSyncStatus`.

R3: Tree is always single-rooted per tenant.
✓ A synthetic root node (`isRoot: true`, tenant's company name, not a real employee) always exists.
✓ Any employee with `managerId == null`, or whose `managerId` doesn't resolve to a user
present in this sync, is attached directly under the root.

R4: Manager-chain cycles are detected and broken automatically at sync time.
✓ Given A→B→A or any longer loop, the last node processed in the loop is treated as unmanaged
(attaches to root) rather than causing infinite recursion or a failed sync.
✓ Each detected cycle is logged with the involved user IDs for admin follow-up.
✓ Order of operations within one sync run: (1) detect and break cycles (R4) first, (2) diff
against the prior tree to find removed managers and reparent their reports one hop up (R5),
(3) attach any node still unmanaged after (1)+(2) to root (R3). A node touched by cycle-break
is resolved before R5/R3 ever consider it.

R5: When a manager disappears (deleted/deactivated, absent from latest sync), their direct
reports reparent one hop up to that manager's own last-known manager.
✓ The prior synced tree (not just the fresh Zitadel pull) is retained as of each sync's start,
so a sync can diff "who was here last time but is missing now" and read that missing
person's last-known `managerId` off the retained prior tree — the new Zitadel payload
alone need not (and generally won't) contain the removed manager's record.
✓ Reparenting only walks one hop (uses the removed manager's own last-known `managerId`) —
never a multi-hop chain-walk.
✓ If the removed manager had no manager of their own, their reports fall back to root (R3).

R6: Department values are normalized at sync time.
✓ `department` is lowercased before storage (`"Engineering"`, `"ENGINEERING"` → `"engineering"`).
✓ Missing/blank department stores as null/empty — never a placeholder string like "unassigned".

R7: Any authenticated tenant user can view the full org chart; only tenant admins can trigger sync.
✓ Non-admin `triggerSync` call is rejected.
✓ Any authenticated tenant member's `getOrgTree` call succeeds and returns the full tree (no
per-viewer redaction).

R8: Org chart UI renders as a visual tree (boxes + connecting lines), not a list/table.
✓ Default render expands to depth 3 from root; deeper nodes show a fold/unfold affordance and
expand only on click.
✓ Each card shows name, title, department (blank if unset), email, and a fold/unfold toggle.
✓ For a tenant with ≤500 synced employees, the page becomes interactive (default depth-3 view
rendered, fold/search controls responsive) within 200ms of data arriving client-side.

R9: Search finds a person by name or email, highlights their card, and reveals it in context.
✓ Match is case-insensitive substring match against name or email (e.g. "jan" matches "Jane
Doe" and "janitor@co.com").
✓ Searching an existing user highlights their card and auto-expands every ancestor along their
chain-to-root so the card is visible without manual clicking.
✓ Searching a non-existent term shows a clear empty state, chart otherwise unchanged.

R10: Internal chain/report-lookup API is available for other engines to consume.
✓ `getChainToRoot` returns an ordered array from the given user up to (and including) the root.
✓ `getReportsByLevel` returns reports grouped into levels (index 0 = direct reports), continuing
until a level has zero members; leaf employees (no reports) yield `[]`.

## §V Invariants

- Auth-provider connectivity is never a dependency of the org-chart _read_ path — only of the
  _sync_ path. (Root cause class this prevents: a future auth-provider outage taking down an
  unrelated internal directory feature.)
- Tree is always single-rooted per tenant — no orphaned employee is ever left unreachable from
  root after a sync completes, including in cycle/deleted-manager edge cases.
- `packages/org-directory` (or wherever this logic lands) never imports/calls Zitadel-specific
  code directly outside the `OrgSourceImporter` boundary — swap-provider requirement.
- Every write to org-tree tables carries tenant_id + RLS per ADR-001; no cross-tenant read path.
- Sync rebuild is all-or-nothing per tenant — no consumer-visible partially-rebuilt tree, ever
  (root cause class this prevents: a query mid-sync returning a tree with some reparented
  nodes and some stale ones, silently inconsistent).
- Only one sync may be in flight per tenant at a time.

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | phase | status      | depends    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- | ---------- |
| T1  | New `packages/org-directory` package (own package, depends on `db` + `auth` only, no `teams` dependency — decided, see §C "new package/module")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 1     | todo        | —          |
| T2  | Add auth-provider metadata read to `packages/auth/src/zitadel-management.ts` for the exact keys `manager_id`/`department`, reusing existing per-tenant cache pattern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 1     | todo        | —          |
| T3  | Schema: `org_employees` (tenant-scoped, RLS, self-referential `parent_id`, nullable `user_id` for the synthetic root, one-root-per-tenant + one-row-per-user-per-tenant partial unique indexes) + `org_directory_sync_runs` (sync status; a partial unique index on `(tenant_id) WHERE status = 'running'` gives R2's per-tenant sync lock for free at the DB level). "Prior tree" (R5) is just the live `org_employees` rows read at the start of a sync transaction, before they're overwritten — no separate history table needed. Basic DB-level RLS isolation tests included in this task (cross-tenant read blocked via `withTenantContext` directly)                                                                      | 1     | todo        | T1         |
| T4  | `ZitadelOrgSourceImporter` + tree-build algorithm (root attach from `tenants.name`, cycle-break, one-hop reparent-on-delete via prior-tree diff, department normalize), rebuild wrapped in a single transaction (R2 atomicity); concurrency guard is the T3 partial unique index, enforced by inserting the `running` sync-run row first                                                                                                                                                                                                                                                                                                                                                                                         | 1     | todo        | T2, T3     |
| T5  | Sync triggers: first-boot auto-seed, 24h scheduled job (worker), admin-only manual `triggerSync` route (relies on the T3 DB-level lock; surfaces `already_running` when the insert conflicts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2     | todo        | T4         |
| T6  | Query API: `getChainToRoot`, `getReportsByLevel`, `getOrgTree`, `getSyncStatus`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 2     | todo        | T4         |
| T7  | admin-ui: tree visualization page (depth-3 default, fold/unfold, search+highlight+auto-expand-ancestors, sync-status indicator, admin-only sync button)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 3     | todo        | T6         |
| T8  | ~~Module seed~~ — dropped. `modules/teams` doesn't exist either (plain tables, ADR-016 Decision 1); org-directory follows the same precedent, no entity-engine module needed. See §C "new package/module"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —     | dropped     | —          |
| T9  | Isolation tests: cross-tenant tree read blocked; RLS on new tables — exercised via the real query API/routes, not schema alone (T3 already covers DB-level RLS directly)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 2     | todo        | T3, T5, T6 |
| T10 | `/security-review` pass (new tables + new routes + service-account credential path — mandatory per `security.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 3     | todo        | T5, T6, T7 |
| T11 | Recommend to a human: author an ADR for the "auth-provider-as-seed-only-source + swappable importer" pattern — reusable beyond this feature, per CLAUDE.md's "write an ADR when a decision isn't covered" rule. Not a blocker for implementation start (ADRs are human-authored, out of agent scope), but should be raised before this ships                                                                                                                                                                                                                                                                                                                                                                                     | —     | needs-human | —          |
| T12 | GDPR erasure wiring (db-conventions.md, #635 — added to the platform after this spec was first drafted): `org_employees`/`org_directory_sync_runs` added to `apps/worker/src/tenant-purge.ts`'s `PURGED_TENANT_TABLES` (full-tenant purge); `org_employees.user_id` added to `apps/api/src/services/user-erasure.ts`'s `USER_REFERENCE_COLUMNS_HANDLED` with a per-user erasure statement that reparents the erased user's direct reports one hop up to their own parent, then deletes their row (same one-hop mechanic as R5, simpler here since no prior-tree diff is needed — the row's own `parent_id` is read directly before delete). Also add a row to `apps/worker/tests/isolation/fixtures/seed-every-tenant-table.sql` | 1     | todo        | T3         |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
