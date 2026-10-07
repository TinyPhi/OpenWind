# 2026-10-05 — org-directory review follow-ups (#745, #754, #755, #727)

**Session type:** follow-ups from the #712, #722 and #723 reviews, combined into one PR
**Branch:** `fix/PLAT-745-org-directory-review-followups`

- **Audit action names (#745, #754, duplicates).** The admin-triggered org-directory sync now
  writes `org_directory.sync_completed` on success (was the generic `updated`) and
  `org_directory.sync_failed` on failure (was the bare `sync_failed`). `AuditAction`,
  `outcome.ts` and `request-kind.ts` changed in the same commit. Both actions classify as
  write / allowed. The scheduled worker sync writes no audit rows, so only the route changed.
- **Migration 0134.** It swaps `sync_failed` for the two new values in `audit_log_action_check`.
  0130 and 0131 are already merged, so neither was edited. As the migration owner, it first
  renames any existing `sync_failed` rows (dev or staging stacks that already ran 0130), so the
  new constraint validates. This is a one-time change to the action label only; actor,
  resource, metadata and timestamp are untouched. Old success rows written as `updated` are
  left alone, because they can't be told apart reliably from other `updated` rows.
- **Org chart highlight (#755).** A search-highlighted card no longer takes the hover style,
  so its border stays orange. The bug only showed after a hover-out, or on a card drawn
  already highlighted, because React only re-applies style keys that changed. The new test
  hovers and then leaves the card; it fails before the fix.
- **Erasure reparenting test (#727).** New isolation test that erases a manager in a
  root → director → manager → report chain. It checks that:
  - the manager row is gone
  - the report moved to the director, not to root
  - a sibling of the manager is untouched
  - `triggered_by` on the manager's sync run is redacted

  The four-level chain is deliberate: in the issue's three-level chain, "one level up" and
  "root fallback" give the same result.

- **Constraint tests.** The org-directory isolation suite now checks that the constraint
  accepts both new actions and rejects `sync_failed`.
- **Verification.**
  - Passed locally: typecheck, lint, the audit/api/admin-ui unit tests for the changed files.
  - Database-backed isolation tests run in CI only: the local stack's migration journal had
    drifted (0129/0130 applied without journal rows).
