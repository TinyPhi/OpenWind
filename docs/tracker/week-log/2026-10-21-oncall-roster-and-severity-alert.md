# 2026-10-21 — On-call roster and severity alert fixes

**Session type:** fix (3E, docs/specs/oncall-routing.md R13a, §B B1–B3)
**Branch:** `fix/oncall-roster-and-severity-alert`

- **Severity alert on create (B1).** `dispatch_severity_notification` read a new ticket's
  severity from `event.fields`, where it never is (severity is its own column), so no alert
  fired on creation. It now reads the stored `entity_instances.severity`.
- **Roster accepts people who haven't signed in (B2).** Schedule create/edit now runs
  `resolveTenantMembers` (#952's helper) before its transaction, so an org member picked from
  the list is recorded instead of failing with 422. Zitadel is never called inside the
  transaction. Only members holding an on-call role (`admin`, `agent`, `user`, shared with
  the picker in `lib/oncall-roles.ts`) are recorded; anyone else, or an id outside the org, is
  still rejected.
- **`user` = employee (B3, R13a).** Owner rule: roles are `admin`, `user` (an employee
  without admin rights, never a customer) and `platform_admin`. The roster picker
  (`GET /admin/members`) now lists `user` members too, so a sandbox (staff seeded as `user`)
  can roster more than its admin. Comments calling `user` the customer role are corrected in
  `members.ts`, `platform/users.ts` and the roster page.
- **Not changed.** On-call read pages stay admin/agent; the reporting spec's and admin-ui's
  "customer" naming is a separate rename.
- **Tests.** Severity on create read from the column (and none when unset); schedule writes
  record picked members with an on-call role before the transaction, skip the lookup when no
  person changes, and still 422 an outsider or a member without an on-call role; the picker
  includes `user` and excludes a `platform_admin`-only account.
