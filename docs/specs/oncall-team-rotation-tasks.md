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
