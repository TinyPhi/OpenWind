# 2026-11-05 — Rotation sweeper only picks up rotations that need work (#1122)

## Done

- `apps/worker/src/oncall-rotation-worker.ts`: the sweep selects active rotations that are due (`next_starts_at <= now + lead`) **or** have a live window starting within the lead, instead of every active rotation across every tenant. The second half is what keeps a failed notice retried: generating a window moves `next_starts_at` a full cycle ahead, so the issue's `next_starts_at`-only filter would have dropped the rotation while its notice was unsent.
- Migration `0161_oncall_rotation_sweeper_schedule_read`: column-level `SELECT (rotation_id, starts_at, deleted_at)` on `on_call_schedules` for `oncall_rotation_sweeper`. No new index: the unique `(rotation_id, starts_at)` index serves the lookup.
- `docs/specs/oncall-team-rotation.md`: the sweeper-reach statement updated.
- Isolation tests: notice still sent when the next cycle is far off; a not-due rotation with no near window is left untouched and picked up once due; the sweeper reads exactly those three schedule columns.

## Needs a human

- ADR-016 addendum A3 describes the sweeper's reach as the six `on_call_rotations` columns. ADRs are human-written; it should gain the three schedule columns.
- New grant on a BYPASSRLS role: `/security-review` required.

## Verification

- Isolation and worker tests were not run locally (no Docker); the generated SQL was checked with drizzle's `toSQL()`. CI runs the isolation suite.
