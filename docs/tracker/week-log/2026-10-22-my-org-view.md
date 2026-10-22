# 2026-10-22 — My Org View: manager rollup on the personal dashboard

**Session type:** feature (docs/specs/my-org-view.md, T1-T11)
**Branch:** `feat/my-org-view` (off fork `main`)

- **Why.** A manager with people below them in the org chart had no way to see their team's
  work. The AuthNexus fork already had an Org View; this ports it onto our own org-directory
  tree (no AuthNexus, no external call) and drops its admin-only-workflows rule.
- **Tree.** New `getSubtreeMembers(tenantId, userId)` in `@platform/org-directory`: every report
  at any depth, never the user themself (also guards a cycle that survived the sync).
- **Shared builders.** My View's ticket pipeline moved to `dashboard/view-builder.ts` with no
  behaviour change (its 14 tests pass unmodified). `includeAssignee` and a per-person roster
  builder are only used by the org views, so My View's response is unchanged.
- **API.** `GET /dashboard/org-view` (the caller is always the JWT user; tickets scoped with
  the unchanged `scoped-access.ts` predicate over `[me, ...subtree]`; roster; `assignedTo` and
  its name only for people in the tree) and `GET /dashboard/team-member-view/:userId`
  (subtree re-checked every request, any miss is the same 404, tickets only).
- **UI.** "My View / Org View" toggle on `/dashboard`, shown only when the user has reports;
  team roster, team tickets (paginated), and a read-only view-as page at
  `/dashboard/team/:userId` with a banner and no notifications.
- **Security review.** No blocking findings. Fixed: an assignee outside the subtree was
  exposed by id, and a surviving cycle could list the caller as their own report. Open for a
  product call: the manager sees tickets a report merely created or was shared on (spec O3).
  Not changed: each request loads the tenant's org rows and up to 2,000 tickets (O1).
- **Tests.** Tree (4 cases), builders, both routes (self-only, any depth, 404 matrix,
  assignee hiding), UI toggle/view-as. The cross-tenant isolation test
  (`dashboard-org-view.isolation.test.ts`) is written but was not run locally (needs the CI
  stack); the full `pnpm test` also runs the worker's isolation suites, which fail against this
  machine's dev database for environment reasons unrelated to this change.
