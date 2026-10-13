# 2026-10-12 — platform-admin dashboard: sandbox list, actions menu, trial editing

**Session type:** Feature (UI) plus a small API and DB change
**Spec:** `docs/specs/multi-org-sandbox.md` R2, R6a (new), T16, T17
**Branch:** `feat/sandbox-16-platform-admin-dashboard-ui` (stacked on `feat/sandbox-15`)

- First pass listed every tenant. After seeing it, the owner decided the dashboard is for
  sandboxes only, so the list is back to `GET /platform-admin/sandboxes` (`is_sandbox = true`).
  Regular tenants such as the dev "Demo Company" never appear, and spec R2 is unchanged.
- `PlatformAdminSandboxView` now includes `trialEndsAt`. This explicitly widens the allow-list
  with a column already inside 0135's grant, and the isolation test's field list is updated.
- New R6a: `POST /platform-admin/sandboxes/:tenantId/trial { trialDays: 1..365 }` sets
  `trial_ends_at` to now plus N days. On an expired sandbox this reactivates it. The route
  invalidates the tenant-status cache so the change applies immediately, and records
  `sandbox.trial_changed` in `platform_admin_audit_log` in the same transaction as the change
  (security review: a change can never commit without its audit row).
- Migration 0142: `platform_admin_role` gets EXECUTE on a SECURITY DEFINER function
  `platform_admin_set_sandbox_trial` (pinned `search_path`; it updates active `is_sandbox` rows only)
  instead of an UPDATE grant on `tenants`, so "sandboxes only" holds in the database even if
  the route has a bug. The audit-log action CHECK gains `sandbox.trial_changed`. The file is
  numbered 0142, after #859's 0141 (renumbered from 0140 when main gained its own 0140).
- Dashboard:
  - Stat cards: sandboxes, active trials, expiring within 7 days, expired.
  - Sandbox table: search, trial filter, sort by name / trial end / created, and a trial
    countdown on each row.
  - A three-dot menu per row and in the detail drawer: Reset, Change trial, Delete.
  - Change-trial dialog: shows the current or expired end date, takes a day count, previews
    the new end date and labels the action "Reactivate" when the trial has expired.
  - Activity timeline grouped by day, with "Load more" and per-sandbox filtering through
    `audit-log?targetTenantId=`.
- Comments in `packages/auth` that called `trial_ends_at` immutable are corrected.
- Tests:
  - Unit tests for the trial route (day arithmetic, cache invalidation, audit write,
    best-effort audit failure, 404, 400 bounds).
  - Isolation tests for the function: it reactivates an expired sandbox and refuses a regular
    tenant; `platform_admin_role` still has no direct UPDATE; `app_user` cannot EXECUTE
    without SET ROLE.
  - The list isolation test is back to "regular tenant never listed".
  - UI tests for the menu, dialog, table, drawer, dashboard and countdown helpers.
- Local dev data: 16 tenants that old isolation-test runs had left in the dev `platform`
  database were deleted (local only). An FK orphan check passed before commit.

## 2026-10-13 follow-up: actions menu clipped by the table

- The three-dot menu rendered inside the table's `overflow-x: auto` box, so it opened inside the
  scrollable list and got cut off. It is now portalled to `document.body` with fixed positioning
  anchored to the button. It opens upward when there's no room below, and closes on Escape, outside
  click, scroll (any scroll container) or resize. Tests cover the portal parent, the up/down flip
  and close-on-scroll.

## 2026-10-13 follow-up: Extend trial and End trial

- Owner request: "Change trial" becomes **Extend trial**, and a new **End trial** forces the
  trial to end now.
- Extend now adds the days to the later of the current end and now (it used to always count
  from now). A running trial gets N more days; an expired or unset one runs N days from today,
  which reactivates it.
- End: `POST /platform-admin/sandboxes/:tenantId/trial/end` sets `trial_ends_at` to now through
  the same 0142 function (active sandboxes only), clears the trial cache, and records
  `sandbox.trial_ended` in the same transaction. 0142 (still unmerged) allows the new action.
- UI: the menu reads Reset · Extend trial · End trial · Delete. End trial asks for confirmation
  and is hidden once the trial has ended. The timeline labels these "Extended trial" and
  "Ended trial", and its filter has both.
- Tests: route units for extend-from-current-end, extend-when-expired and end; an isolation case
  for ending a trial plus its audit row; UI tests for the menu order, the confirm + endpoint,
  hiding End once ended, and the extend preview.

## 2026-10-13 follow-up: PR #880 review round 3

- [A] #880 and #869 both numbered their migration 0142. Agreed order: #880 merges first and
  keeps `0142_platform_admin_sandbox_trial`; #869 renumbers to 0143 with a later journal `when`
  (drizzle's migrator skips entries older than the last one applied). Recorded in both PRs.
- [B] Extend read the current end and wrote the new one in separate transactions, so two
  concurrent extends could overwrite each other. 0142 now has
  `platform_admin_extend_sandbox_trial(tenant_id, days)`: one UPDATE computes
  `GREATEST(now(), COALESCE(trial_ends_at, now())) + days`, so concurrent extends take the row
  lock in turn and stack. An isolation test fires two 7-day extends in parallel and expects +14.
- [C] End trial was offered, and allowed, for a sandbox with no trial, which would create an
  expired trial and lock users out. `platform_admin_end_sandbox_trial(tenant_id)` only ends a
  trial with `trial_ends_at > now()`. The route returns 409 `NO_ACTIVE_TRIAL` for no trial or an
  already-ended one, and the menu shows End trial only while a trial is running.
- The generic `platform_admin_set_sandbox_trial` function is gone: two narrower functions
  replace it, with the same SECURITY DEFINER, pinned `search_path` and EXECUTE-only-for-
  `platform_admin_role` lockdown. The audit row is still written in the same transaction and
  rolled back when nothing changed.
- [D] (extend dialog not resetting) needed no change: the dialog only mounts while open, so
  each open starts from fresh state.
