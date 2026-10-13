# 2026-10-12 — platform-admin audit trail (T16, multi-org sandbox Phase 3)

**Session type:** Feature implementation
**Spec:** `docs/specs/multi-org-sandbox.md` T16 (R9), ADR-022 Decision 7
**Branch:** `feat/sandbox-14-platform-admin-audit-log`

- ADR-022 was already merged (#781) with Decision 7 naming a dedicated,
  tenant-id-less `platform_admin_audit_log` table as the chosen mechanism — T16 implements
  exactly that design, no new decision needed.
- New migration `0140_platform_admin_audit_log.sql`: `platform_admin_audit_log` (`id`,
  `actor_sub`, `action` CHECK'd to the 3 sandbox lifecycle actions, `target_tenant_id`,
  `created_at`), no `tenant_id` column and no RLS (it is platform-level, not tenant data).
  No FK on `target_tenant_id` — a `sandbox.deleted` row must survive the target tenant row
  being gone. `platform_admin_role` is granted `SELECT` only; every row is written by the
  sandbox lifecycle workers on the privileged `db` connection, mirroring the write/read split
  already established for `tenants`' lifecycle columns (migration 0135).
- Because the table has no `tenant_id` column, neither of the two erasure-drift guards
  (`erasure-table-coverage-guard`, `erasure-user-column-coverage-guard`) scan it at all —
  same reasoning already established for `sandbox_provisioning_jobs` in migration 0137. No
  purge/erasure wiring was needed or added.
- New `@platform/db` module `platform-admin-audit.ts`: `recordPlatformAdminAction` (insert,
  called from `sandbox-{provisioning,reset,delete}-worker.ts` on the success path only,
  alongside each flow's existing `admin_audit_log` write) and `listPlatformAdminAuditLog`
  (keyset-paginated by `created_at`, newest first — not offset pagination, since this table
  only grows and an offset page can skip/duplicate rows across requests).
- New `GET /platform-admin/audit-log`, gated behind `requirePlatformAdmin` like every other
  route in this tree, `limit`/`before` query params validated via Zod.
- Per spec R9, a failed or abandoned action writes nothing here — confirmed via tests on all
  three workers that a thrown error short-circuits before `recordPlatformAdminAction` runs.
- New tests: assertions added to all three existing worker unit-test suites (one new
  "does not record on failure" test per worker, plus the happy-path assertion on each
  existing completed-action test), 4 new route unit tests (default limit, explicit
  limit/cursor pass-through, 400 on over-limit, 400 on a malformed cursor).
- Confirmed pre-existing/unrelated via full-suite reruns on both the base branch and this
  one: `entity_links` DB-drift isolation failures (a stale local-only table with no
  corresponding schema/migration entry — confirmed via `\d entity_links` against both local
  Postgres catalogs) and an `upload-flow.test.ts` `UNDEFINED_VALUE` failure — none touch any
  file this PR changes, and none would reproduce against a CI database built fresh from
  migrations.
