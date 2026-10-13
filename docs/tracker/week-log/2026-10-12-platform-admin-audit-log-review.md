# 2026-10-12 — PR #859 review fixes (T16 platform-admin audit trail)

**Session type:** Review fix
**Spec:** `docs/specs/multi-org-sandbox.md` T16
**Branch:** `feat/sandbox-14-platform-admin-audit-log`

- [B] Reverted `docs/decisions/ADR-022-sandboxing.md` to `main`. The original T16 commit had
  edited Decision 7 to "implemented"; ADR files are human-authored per CLAUDE.md, so that edit
  doesn't belong in an agent PR. A human can mark the decision implemented separately.
- [C] `recordPlatformAdminAction` is now best-effort in the provisioning, reset and delete
  workers: a failure is logged and the job still succeeds. `admin_audit_log`'s `*_completed`
  entry stays the authoritative record, with no contradictory `*_failed` entry. For
  provisioning the stakes were higher than the review noted: the call sat inside the `try`
  whose `catch` runs the T11 rollback, so a failed T16 write would have deleted a fully built
  sandbox. One test per worker; all three fail against the pre-fix code.
- [F] The isolation pagination test took "the globally newest row" as its cursor, which on a
  table with no `tenant_id` can belong to any concurrent test, so it could pass without
  checking anything. It now inserts its own older and newer rows, uses the newer one as the
  cursor, and asserts the older row is returned and every row is strictly older.
- Not changed: [A] migration `0140` also claimed by #857 — whichever merges second
  renumbers (likely this one, as it sits behind four stacked PRs); [D] worker wiring already
  landed with #838; [E] `invalidateTenantStatusCache` is synchronous; [G]/[H] are follow-ups;
  [I] resolved by #838 merging.
