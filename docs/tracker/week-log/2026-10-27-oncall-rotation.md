## 2026-10-27 — Recurring on-call rotation (PR B of oncall-team-rotation)

**Session type:** implementation (spec-driven; plan-lock approved)
**PR:** none yet. Built locally on top of PR A (#1103); the PR opens after #1103 merges and the branch is replayed onto `main`.
**Branch:** `feat/oncall-rotation`
**Spec:** [oncall-team-rotation](../../specs/oncall-team-rotation.md), PR B (T7–T12); ADR-016 addendum A2–A4 (human-authored).

An admin can repeat a roster every N days. A worker creates each next window by itself, moves primary and backup to the next people on the team, and tells the people taking over.

| State                                                               | Event                                           | Outcome                                                                                                                               | Kind       | Evidence                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| Repeat is off                                                       | Admin creates a window                          | A plain window, no rotation, nothing changes from today                                                                               | unchanged  | schedule route tests, isolation "repeat is off"             |
| Team has members, repeat on (3–90 days)                             | `POST /admin/on-call-schedules` with `repeat`   | First window with exactly the chosen people plus one active rotation, created together and audited                                    | introduced | route tests, `on-call-rotations-routes` isolation           |
| Team already has an active rotation                                 | Same request                                    | `409`, nothing written                                                                                                                | introduced | route and isolation tests                                   |
| Team has no members                                                 | Same request, or resuming a rotation            | `422` on `repeat` / `status`; nothing written                                                                                         | introduced | route and isolation tests                                   |
| Current window ends within 2 days                                   | Worker tick                                     | Next window is made, back to back, N days long; primary and backup move to the next members (wrapping, never the same person twice)   | introduced | worker isolation tests, `rotation.test.ts` (24)             |
| Several workers, or a rolling deploy                                | Ticks at the same time                          | Exactly one window and one set of notices (row lock + unique indexes)                                                                 | introduced | "exactly once however many ticks run at the same time"      |
| Worker was down for several cycles                                  | Next tick                                       | Steps through every missed cycle (cap 52), makes rows only for windows not yet over, never back-fills history                         | introduced | "steps through missed cycles" and cap tests                 |
| A manual window overlaps the next generated one                     | Worker tick                                     | Rotation is marked blocked with the reason, nothing is overwritten; it resumes once the overlap is cleared                            | introduced | "blocks on a manual window" isolation test                  |
| Admin deletes a generated window                                    | Later ticks                                     | Not regenerated (a gap, as a manual delete); the rotation carries on with the following cycle                                         | introduced | "does not regenerate a deleted window"                      |
| Admin edits the latest window                                       | Next generation                                 | Continues from the edited people                                                                                                      | introduced | "continues from an admin's edit"                            |
| Previous holder left the team                                       | Next generation                                 | Head of the team list takes over; escalation manager left empty if they left                                                          | introduced | rotation unit tests, worker test                            |
| Rotation stopped, past its end date, team deleted, tenant suspended | Worker tick                                     | Nothing is generated and no notices go out                                                                                            | introduced | worker isolation tests                                      |
| Window starts within 2 days and has not started                     | Worker tick                                     | Primary, backup and escalation manager each get one in-app notification and the usual email, once per (window, person, role)          | introduced | "tells the new primary, backup and escalation manager once" |
| Person added to a not-yet-started window                            | Next tick                                       | The new person is told once; the one removed is not                                                                                   | introduced | "tells a person added to a window"                          |
| Window has already started                                          | Worker tick                                     | Never announced                                                                                                                       | introduced | "never announces a window that has already started"         |
| Admin stops, resumes or ends a rotation                             | `PATCH` / `DELETE /admin/on-call-rotations/:id` | Stop keeps every window; resume needs members, a live team and no other active rotation (`409`/`422`); end date can be set or cleared | introduced | route and isolation tests                                   |
| Another tenant targets a rotation                                   | Any rotation request                            | `404`; rows unchanged; RLS hides them without the explicit filter                                                                     | introduced | isolation tests                                             |
| Roster page                                                         | Admin opens a team                              | Windows of a rotation show ↻; a panel shows cycle, status (active, stopped, blocked with reason), next window and who is next         | introduced | roster page tests (11 new)                                  |

`resolve_oncall` is unchanged: generated windows are ordinary schedule rows.

## Decision notes

- **The worker's database role is read-only.** `oncall_rotation_sweeper` can read six columns of `on_call_rotations` (BYPASSRLS, for cross-tenant discovery) and nothing else. Generation, the cursor update and notices all run in a normal per-tenant transaction under RLS. This is narrower than the spec's "read and advance rotations"; the spec's invariant is updated to match.
- **Notices are sent when a window starts within 2 days**, not at creation: a generated window is made when the current one is within 2 days of ending, so it is announced right away, and an edit or a first window made further out is announced once it gets close.
- **`notifications.type` is a database CHECK.** The new type `oncall.rotation_notice` is added in migration 0158 with every previous value kept. A mocked-database test cannot see this, so the worker test runs against a real database.
- The overlap check and the insert are in one transaction, and the insert names its conflict target so a concurrent manual window raises an error and rolls back (the next run then blocks on it) instead of silently skipping a cycle.
- Migration number 0158 follows PR A's 0157 (merged in #1103).
- Outside the plan-lock's scope paths: `apps/api/src/app.ts` (router mount), `apps/worker/package.json` and `pnpm-lock.yaml` (a workspace dependency on `@platform/teams`; pnpm could not rewrite the lockfile offline, so the one entry was added by hand and pnpm's frozen-lockfile check accepts it).

## Review

- `/security-review` (reviewer agent): no blocking, high or medium findings. Low: a manual window created between the clash check and the insert could silently skip a cycle (fixed, above); resuming the rotation of a deleted team left it active but inert (fixed, resume is refused with `422`); discovery has no batch limit (not changed: at most one active rotation per team, and the tick interval bounds the rate; revisit if rotation counts grow).

## Verification

- `pnpm typecheck` and `pnpm lint`: pass (52/52).
- Unit and route tests: `@platform/teams` 39, `@platform/config` 110, admin route tests 207, worker lifecycle and wiring tests, admin-ui roster 18. The full admin-ui suite passes except `lazy-routes.test.ts`, which timed out once under full-suite load and passes on its own (71 tests).
- Isolation, on a throwaway Postgres with every migration applied (including 0158): rotation routes (10), worker (18), the two erasure coverage guards, the user-data export guard, user-erasure suites, team-member isolation tests and all tenant-purge isolation files.
- Root `pnpm test` was not run (`.env.local` points at the live dev database).
- Not covered by a test: the race between a manual window and generation (it needs two transactions interleaved); the fix is by construction.
