# 2026-09-09 — 3E Phase 1 DB layer merged (PR #583)

## Done

- PR #583 (`feat(db): add teams, services & on-call schedule data model`) merged to main
  (commit `bb5089cf`) — TusharSharma991, reviewed by PrabhuVijit
- Phase 1 issue #565 closed
- Phase 2 issue #567 notified and unblocked

## What shipped

- `teams` table — RLS read/write pair (USING + WITH CHECK), soft-delete partial unique index
  on `(tenant_id, name)`, `created_by text NOT NULL`, analytics annotation
- `services` table — same pattern; `team_id uuid` with no DB FK (cross-tenant ownership is
  app-layer only per R1d/T44 — FK bypass of RLS was the documented reason)
- `on_call_schedules` table — RLS, soft-delete, repo's first `btree_gist` GIST exclusion
  constraint (`EXCLUDE USING gist` on `(tenant_id, team_id, tstzrange(...))`) enforcing
  no-overlapping-windows at the DB layer; all user-reference columns typed `text` (Zitadel
  JWT sub claims, not UUID PKs)
- `admin_audit_log` CHECK constraint extended: `oncall.auto_assigned`, `oncall.no_schedule`,
  `oncall.skipped_explicit_assignee` — wired into `@platform/audit`'s `AuditAction` union
  and both exhaustiveness maps in the same commit
- New `@platform/teams` package: `validateCrossTenantRefs` + `lookupValidIdsInTable` —
  generic, table-agnostic cross-tenant FK validation helper (reused by 3F temporal scheduler)
- Isolation tests: read + write isolation for all three tables; GIST overlap rejection test
- `CLAUDE.md` dependency table updated: `teams → db only`
- `.claude/rules/db-conventions.md` updated with cross-table FK validation pattern

## Review findings resolved in this PR

All 4 original blockers (B1–B4) from the principal-engineer review resolved before merge.
Self-caught fix in the process: `created_by`/`primary_user_id`/`backup_user_id`/
`escalation_manager_user_id` corrected from `uuid` to `text` (Zitadel sub claims).

## Follow-up issues (non-blocking, filed)

- #587: Verify `resolve.alias` vs `deps.inline` for `@platform/teams` in `apps/api/vitest.config.ts` before Phase 2 routes
- #588: `lookupValidIdsInTable` — no compile-time check that `softDeleteColumn` belongs to `table`
- #589: Document that `pnpm db:push` silently omits the GIST exclusion constraint

## Next

Phase 2 (#567) — API layer: teams, services, schedules CRUD routes + isolation tests.
Pre-Phase-2 action: check #587 (resolve.alias vs deps.inline) before opening Phase 2 PR.
ADR-016 still pending human acceptance (human-authored; blocks automation engine work in Phase 3).
