# 2026-10-22 — Sandboxes get a three-level org chart, and older ones can be back-filled

**Session type:** feature (docs/specs/multi-org-sandbox.md R3)
**Branch:** `feat/sandbox-org-seeding` (off `upstream/main`)

- **Why.** A new sandbox's accounts had no manager, department or title in Zitadel, so its org
  chart was one flat row under the root card.
- **Default structure.** `sandboxOrgPlacement(position)` (one pure function, `packages/auth`):
  three managers (the admin plus two members; Engineering, Sales, Support), two team leads under
  each, and the remaining members as employees under the leads. The org template and the
  back-fill both use it, so they cannot drift.
- **Provisioning.** After all accounts exist, the worker writes each account's `department`,
  `title` and `manager_id` (new `setUserOrgMetadata`) before the org sync, so the chart has its
  levels from the first sync. A failed write is logged and leaves that account under the root.
- **Back-fill.** `POST /platform-admin/sandboxes/:tenantId/seed-org-tree` (fresh MFA) and a
  "Seed org chart" item in the sandbox actions menu. Orders the org's accounts by name, applies
  the same structure, overwrites the three metadata keys, then runs the org sync. 404 for a
  tenant that is not a sandbox or has no mapped org.
- **Security review.** No blocking findings. Fixed: `setUserOrgMetadata` now drops the cached
  metadata so the sync right after a re-seed reads the new values, not the 5-minute-old ones.
  Left as a follow-up: a platform-admin audit entry (needs a migration to widen the action
  CHECK). The empty-value-skipped case was fixed in the review follow-up below.
- **Depends on.** The sync only reads the metadata once the `ListUserMetadata` fix is in (separate
  PR); the org chart page only draws every level once the tree-key fix is in (separate PR).
- **Tests.** Placement, template shape, worker writes (order and manager ids), route (404s,
  MFA, 502), menu item and MFA retry, `setUserOrgMetadata` (request shape, cache drop), and an
  isolation test that runs the real route and sync against Postgres with only Zitadel stood in.
- **Review follow-up (2026-10-28).** Both reviews asked for a null manager to be cleared, not
  skipped, and found that the isolation test's stand-in for Zitadel hid it by writing null itself.
  Seen live on the test server: after accounts changed and the chart was re-seeded, all three
  top-level managers kept a stale `manager_id` and the whole organisation chained under one person.
  Fixed: `setUserOrgMetadata` removes the key on an explicit null (`DeleteUserMetadata`; a 404
  counts as already clear and logs a warning), while undefined or empty is still left alone.
  The isolation test's stand-in now follows the same rules, and a new case seeds over an earlier
  structure (a mutual manager pair and a top-level manager with a lead as manager) and checks the
  chart; it fails against the old behaviour. The spec's known-limits note is replaced.
