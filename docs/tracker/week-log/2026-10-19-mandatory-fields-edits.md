# 2026-10-19 — Mandatory ticket fields PR 2.3: edits, assignee optional, on-call everywhere

**Session type:** feature (docs/specs/mandatory-ticket-fields.md, PR 2.3)
**Branch:** `feat/mandatory-fields-edits` (off `main` at #1003; rebased after #1004 merges)

- **Owner decision (2026-10-19).** Four values are mandatory: title, due date, remark,
  severity. The assignee is optional: an unassigned ticket stays on its workflow's records list
  under the "Unassigned" filter. A team is only a way to reach whoever is on call. This drops
  the erasure/access-revoke reassignment (T9) and the partner-API fallback owner (T11, and with
  it the ADR-012 amendment).
- **Engine.** The mandatory check covers the four. A new update check runs on every
  `updateEntity`/`bulkUpdateEntities` call for a workflow record and flags only a value the
  record had (log, or reject under enforce), so older records missing one can still be edited.
  A changed due date must not be in the past; an untouched overdue one saves.
- **Bug (B7).** A fields edit dropped keys the type doesn't define, including the ticket's
  access grants (`__accessUsers`) and a `team_id` on helpdesk-style types: the create schema
  strips unknown keys and the result replaced `fields`. Both update paths now keep them.
- **API.** `PATCH /entities/:id` and bulk PATCH reject a null due date. Create and sub-task
  create accept no assignee (still at most one of person/team). `GET /entities?unassigned=true`.
  Automations with nobody to assign create the ticket unassigned instead of failing.
- **UI.** "Unassigned" is the create form's default and an option in the ticket's Edit form,
  quick-assign and sub-task form. The records list sends the "Unassigned" filter to the server.
- **On-call (B8).** The two seeded `resolve_oncall` rules were scoped to the entity type
  named `ticket`, so team assignment on other workflows never reached a person. The seed is
  unscoped and migration 0152 widens existing rules (0151 went to #1006; whichever of this and #1004 merges second renumbers on rebase).
- **Tests.** Engine (four values, update check), isolation (fields edit keeps grants and team,
  due-date edit rules, unassign under enforce), routes (null due date, unassigned create and
  sub-task, `unassigned=true`), automations (unassigned instead of failure), admin-ui (create
  default, Edit unassign, sub-task, records filter), seed guard for the on-call rules.
- **Left out.** A soft-deleted team leaves tickets pointing at it; bulk update records the
  actor as "system". Both are follow-ups.
