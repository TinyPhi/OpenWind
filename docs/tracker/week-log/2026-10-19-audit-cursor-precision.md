# 2026-10-19 — Audit log keyset cursor precision (#993)

**Session type:** Follow-up from the review of #991
**Branch:** `fix/PLAT-993-audit-cursor-precision`
**Issue:** #993

- **Found.** `listPlatformAdminAuditLog` selected the cursor row into JavaScript, so `created_at` came back as a `Date`
  (the column uses Drizzle's default `mode: "date"`: milliseconds) while Postgres stores microseconds. The next page
  asked for `created_at < T OR (created_at = T AND id < cursor.id)` with `T` truncated to the millisecond. A row whose
  `created_at` fell between `T` and the cursor row's real value satisfied neither branch and was skipped, so #894's
  "never skipped on equal timestamps" held only for exact ties at whole milliseconds.
- **Fixed.** The comparison now happens in SQL against the cursor row,
  `(created_at, id) < (select created_at, id from platform_admin_audit_log where id = $cursor)`, so the precision never
  leaves the database. A cursor id that does not exist gives NULL, so no rows, as before. The separate cursor select is
  gone (one query instead of two).
- **Verified on real Postgres** (`platform-admin-audit-cursor.isolation.test.ts`, rows inserted at explicit microsecond
  timestamps): paging by 2 and by 1 returns every row newest first when five rows share a millisecond; rows with an
  identical timestamp are ordered by id without skips or repeats; an unknown cursor returns nothing; the tenant filter
  holds while paging. Against the old code three of the four fail; with the fix all four pass. The unit test that pinned
  the old two-step query now pins the single query.
- **Practical weight.** Low: audit rows come from human platform-admin actions and rarely land within one millisecond,
  and rows written in one transaction share an exact timestamp. The fix is small and makes the claim in #894 true.
