# 2026-10-12 — platform-admin dashboard: all tenants + activity timeline

**Session type:** Feature (UI) with a small API change
**Spec:** `docs/specs/multi-org-sandbox.md` R2 (amended), T16, T17
**Branch:** `feat/sandbox-16-platform-admin-dashboard-ui` (stacked on `feat/sandbox-15`)

- Owner decision: the platform admin's list shows every tenant, not only sandboxes. The
  sandbox-only `GET /platform-admin/sandboxes` list became `GET /platform-admin/tenants`. It
  returns the same `PlatformAdminSandboxView` allow-list (id, name, isSandbox, createdAt,
  trialStatus) for every row, so a regular tenant exposes nothing more. No new grant: 0135
  already scopes `platform_admin_role` to those `tenants` columns for all rows. Detail, reset
  and delete stay sandbox-only (404 otherwise). Spec R2 is amended. ADR-022 Decision text
  ("list sandboxes") still needs a human-authored note.
- `GET /platform-admin/audit-log` gained an optional `targetTenantId` filter, which also works
  with the keyset `before` cursor. It drives the per-tenant timeline.
- Dashboard redesign: stat cards (total, sandboxes, customers, active and expired trials); a
  tenants table with search (name or id prefix), type and trial filters, sortable name and
  created columns, badges and relative dates; reset/delete on sandbox rows only; a detail
  drawer per tenant with metadata, actions and that tenant's timeline; and a global activity
  timeline grouped by day, with an action filter, "You" for your own actions, "Deleted tenant
  <id>" for gone tenants, and "Load more". Loading skeletons and empty/error states included.
  Styling uses the existing theme tokens, so light and dark mode both work.
- Not built, and why: a trial countdown and an "expiring within 7 days" card need
  `trial_ends_at` in the view, which the locked allow-list excludes (it carries trialStatus
  only). This is deferred to an explicit decision. The org-chart view is left out per the owner
  (spec R2 forbids org-chart contents).
- Tests: route units for `/tenants` and the audit filter; the list isolation test now asserts
  a regular tenant is listed with only the allow-listed fields and still 404s on detail; the
  audit-log isolation test covers the tenant filter with and without a cursor; and UI tests for
  the dashboard, table, timeline, drawer and format helpers.
