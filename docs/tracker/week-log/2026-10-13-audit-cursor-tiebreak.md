# 2026-10-13 — Audit log cursor tie-break (#878)

**Session type:** Code
**Branch:** `fix/PLAT-878-audit-cursor-tiebreak`

- `queryAuditLog` now pages on the total order `(created_at DESC, id DESC)`. The cursor still resolves from a row id, so the API contract is unchanged. Rows that share a `created_at` (several audit entries written in one transaction) are no longer skipped across a page boundary.
- The cursor timestamp now round-trips as text rather than a JS `Date`, which truncated the column's microseconds and could skip rows that differ only below a millisecond (the old code had the same flaw).
- The cursor lookup now also filters on `tenant_id` explicitly instead of relying on RLS alone.
- Added an isolation regression test that seeds equal-`created_at` rows and pages with `limit: 1`; it fails on the old code. Also covers microsecond-only differences and a cross-tenant cursor id being ignored.
- Not added: a `(tenant_id, created_at DESC, id DESC)` index. No migration; revisit if audit-log paging shows in query plans.
