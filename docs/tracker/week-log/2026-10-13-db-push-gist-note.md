# 2026-10-13 — db-conventions: why never `db:push` (#589)

**Session type:** Docs
**Branch:** `docs/PLAT-589-db-push-gist-note`

- `.claude/rules/db-conventions.md` now says to build databases with `pnpm db:migrate`, and why: Drizzle's schema cannot represent the `btree_gist` exclusion constraint on `on_call_schedules` (migration 0094), so `db:push` / `db:generate` silently omit it.
