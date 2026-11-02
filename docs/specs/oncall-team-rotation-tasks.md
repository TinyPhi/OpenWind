# Implementation Plan: On-call team members (PR A of oncall-team-rotation)

**Spec:** docs/specs/oncall-team-rotation.md (§R1–R3, R10; §T PR A, T1–T6)
**Generated:** 2026-10-28
**Status:** PR A implemented, in review
**Branch:** `feat/oncall-team-members`, off `upstream/main`. PR B (recurring rotation, T7–T12) is planned
separately on `feat/oncall-rotation` after this merges.
**Blocked on:** nothing (ADR-016 addendum recorded 2026-10-28).

---

## Phase 1 — Data

**Goal:** a team can hold an ordered list of members, safely per tenant.
**Gate:** migration applies on a throwaway Postgres; db unit tests and the two erasure coverage guards pass

| task                                                                              | requirement | status |
| --------------------------------------------------------------------------------- | ----------- | ------ |
| T1: `team_members` migration, RLS, indexes, purge and erasure wiring, fixture row | R1, R10     | done   |

## Phase 2 — API

**Goal:** members are managed through the teams API, and schedules accept only team members.
**Gate:** route tests pass + Phase 1 gate still green

| task                                                                           | requirement | status |
| ------------------------------------------------------------------------------ | ----------- | ------ |
| T2: members on read, `memberUserIds` on create, `PUT /admin/teams/:id/members` | R1, R10     | done   |
| T3: schedule create and patch require the roles to be team members             | R3          | done   |

## Phase 3 — UI, isolation, review

**Goal:** an admin builds a team from users and the roster modal offers only that team.
**Gate:** §R1–R3 acceptance criteria met; full exit condition green

| task                                                            | requirement | status |
| --------------------------------------------------------------- | ----------- | ------ |
| T4: teams page — create with members, edit, reorder, show names | R1, R2      | done   |
| T5: roster modal — team first, pickers limited to its members   | R3          | done   |
| T6: isolation tests, `/security-review`, docs                   | R10         | done   |

---

## Kick-Off Prompt

Read docs/specs/oncall-team-rotation.md (§R1–R3, R10; PR A) and this file. Confirm the ADR-016 addendum
exists before starting. Implement Phase 1 (T1) first. Do not start Phase 2 until Phase 1 tests pass. Stop
and ask on any decision the spec does not cover. Log failures with `/spec amend §B`.

---

# Implementation Plan: Recurring on-call rotation (PR B of oncall-team-rotation)

**Spec:** docs/specs/oncall-team-rotation.md (§R4–R10; §T PR B, T7–T12)
**Generated:** 2026-10-27
**Status:** implemented locally (T7–T12); waits on PR A to merge before the PR opens
**Branch:** `feat/oncall-rotation`, built locally on top of `feat/oncall-team-members` (PR A, #1103 open).
Upstream squash-merges, so no PR is opened until #1103 merges; then `git rebase --onto upstream/main
feat/oncall-team-members feat/oncall-rotation`, renumber the migration if `main` took 0156 or later, re-run
the checks and open the PR.
**Blocked on:** nothing for design (ADR-016 addendum A2–A4 covers it). PR open waits on #1103.

Design anchors (already decided in the spec and addendum): DB polling with `FOR UPDATE SKIP LOCKED` and a
tenant active/trial guard, copied from `apps/worker/src/schedule-tick-worker.ts`; a narrow BYPASSRLS
sweeper role with column-scoped grants, copied from `0107_schedule_sweeper_role.sql`; notices through the
existing notification tables and `notifyOutboundQueue`; generated windows are ordinary `on_call_schedules`
rows, so `resolve_oncall` is unchanged.

---

## Phase 1 — Data and pure logic

**Goal:** the tables, the worker's database role and the rotation rules exist and are provably correct, with no I/O.
**Gate:** migration applies on a throwaway Postgres; erasure and purge guards pass; pure-function unit tests pass

| task                                                                                                                                                                                                                   | requirement    | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| T7: migration (`on_call_rotations` with cursor, `rotation_id` + unique `(rotation_id, starts_at)`, `on_call_schedule_notices`, `oncall_rotation_sweeper` role and grants, audit actions), purge/erasure wiring, config | R4–R6, R8, R10 | done   |
| T8: `@platform/teams` pure rotation functions: next assignment with wrap, collision skip, departed-member rule, window generation with the 52 cap and no back-fill; unit tests                                         | R5, R6         | done   |

## Phase 2 — API and worker

**Goal:** an admin can create and manage a rotation, and the worker creates windows and notices on its own.
**Gate:** route and worker tests pass + Phase 1 gate still green

| task                                                                                                                                                                                  | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T9: API: `repeat` on schedule create, `/admin/on-call-rotations` list/patch/delete, one active per team (`409`), member-count rules (`422`), audit                                    | R4, R9, R10 | done   |
| T10: worker `oncall-rotation-worker`: claim as the sweeper role, generate, overlap-block, catch-up, notices (in-app + email, once per window/person/role), tenant guard, entry wiring | R5–R8       | done   |

## Phase 3 — UI, isolation, review

**Goal:** an admin sees and controls the rotation on the roster page.
**Gate:** §R4–R10 acceptance criteria met; full exit condition green

| task                                                                                                                                                       | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T11: admin-ui: "Repeat every N days" in the modal, rotation markers on the roster, rotation panel (status, next window, who is next, stop/resume/end date) | R4, R9      | done   |
| T12: isolation tests (rotations, notices, the sweeper role's reach, concurrent claims, blocked overlap); `/security-review`; docs                          | R10         | done   |

---

## PR B Kick-Off Prompt

Read docs/specs/oncall-team-rotation.md (§R4–R10; PR B) and this file. Confirm the plan-lock for
`feat/oncall-rotation` is approved. Implement Phase 1 (T7, T8) first. Do not start Phase 2 until Phase 1
tests pass. Stop and ask on any decision the spec does not cover. Log failures with `/spec amend §B`.
