# 2026-10-12 — Audit trail for permission changes (#640)

**Session type:** Code
**Branch:** `feat/PLAT-640-audit-role-permission-changes`

- Scouting showed OpenWind stores no user roles: `tenant_users` has no role column and `requireRole`
  reads Zitadel JWT claims or `api_keys.scopes`. So there is no `role.granted` to log. The
  permission state that does change in OpenWind's own tables and was unaudited is the per-ticket
  `__accessUsers` ACL (four raw-SQL writers that bypass the entity audit hook), `workflows.assigned_to`
  and `workflow_transitions.allowed_roles`. API-key scopes, on-call rosters, teams, services,
  notification policies and schedule rules were already audited.
- Added `access.granted|updated|revoked`, `workflow.admins_updated` and
  `workflow.transition_roles_updated`, each written on the same `withTenantContext` transaction as
  the change (fail closed). A canvas save is one entry however many transitions changed; a no-op
  edit writes nothing.
- Migration 0140 (not 0139): the open sandbox-delete PRs (#838-#842) hold 0139 and widen the same
  CHECK constraint. 0140 lists every action including their `sandbox.delete_*` pair, so the
  constraint is right whichever PR merges first. Whichever of the two lands second must re-list the
  other's values if its migration is ever rewritten.
- Ticket ACL denial for a customer on `GET /entities/:id` and on commenting reuses
  `ticket.view_denied` / `comment.access_denied` with actor type `user`; no new action or alerting.
  One row per attempt, with no rate cap, as on the third-party path.
- **Partly met, by design:** #640's second criterion asks for cross-tenant attempts to be logged.
  With RLS plus the explicit tenant filter, another tenant's id returns no row, the same as a
  missing id, so no denial branch exists to log, and adding an RLS-bypassing lookup would weaken
  isolation. Not implemented; the PR references #640 rather than closing it.
- Review (four lenses, each finding checked by a skeptic): seven of eleven findings refuted. Fixed
  two: deleting a transition (its own route, and the canvas save, including cascade deletes) now
  audits the removed role gate, and re-saving an identical ACL entry writes nothing. A no-op
  revoke (target has no entry and is not the assignee) also writes nothing; the test agent found
  that one.
- **Known gap, not fixed here:** the new entries carry other users' ids in JSON columns
  (`metadata.targetUserId`, `assignedTo` snapshots). Tenant-purge anonymization
  (`anonymizeAuditLogForTenant`) rewrites only `actor_id` and `acting_person_id`, so those ids
  survive a purge until the 90-day rollup. Existing writers already do the same (on-call roster
  and entity snapshots), so this is a systemic gap this change makes slightly wider, not a new
  kind. Needs an owner call: scrub known JSON keys in the purge, or amend the R9 wording.
- A missing record on `GET /entities/:id` returns `ENTITY_NOT_FOUND` / "Not found" while an
  ACL denial returns `NOT_FOUND` / "Record not found". Pre-existing, so the 404 bodies are not
  byte-identical on that route; the new audit write does not change either body. Left alone.
- Deferred, unlisted elsewhere: itemised audit of sandbox-seeded accounts, the scheduled
  org-directory sync (writes no entry at all), and per-row `org_employees` reparenting.
