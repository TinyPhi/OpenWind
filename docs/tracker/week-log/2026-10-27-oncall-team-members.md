## 2026-10-27 — On-call teams with members (PR A of oncall-team-rotation)

**Session type:** implementation (spec-driven; plan-lock approved)
**PR:** pending (`feat/oncall-team-members`)
**Branch:** `feat/oncall-team-members`
**Spec:** [oncall-team-rotation](../../specs/oncall-team-rotation.md), PR A (T1–T6); ADR-016 addendum 2026-10-28 (human-authored).

A team is now an ordered list of members. The roster modal picks a team first and offers only that
team's members. Recurring rotation and advance notice (PR B) are not part of this PR.

| State                                                   | Event                                    | Outcome                                                                                                        | Kind       | Evidence                                               |
| ------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| Team has no members (every existing team)               | Admin opens the team or the roster modal | Behaves as before; the modal says adding members limits the choice                                             | unchanged  | roster modal and schedule route tests                  |
| Admin creates a team with `memberUserIds`               | `POST /admin/teams`                      | Team and ordered members are written in one transaction; a refused member writes nothing                       | introduced | teams route tests, isolation "failed create" case      |
| Admin saves a new member list                           | `PUT /admin/teams/:id/members`           | List replaced; positions renumbered 0..n-1; before/after audit entry; team row locked against concurrent edits | introduced | route tests, positions isolation test                  |
| List contains someone already on the team who lost role | Same PUT                                 | Only people being added are checked against live Zitadel roles, so the edit succeeds                           | introduced | "does not re-check people who are already on the team" |
| List contains a user from another org or tenant         | Same PUT or create                       | `422` on `memberUserIds[i]`, same message as any ineligible user; no confirmation the id exists                | introduced | isolation "cross-org" case                             |
| Another tenant's admin targets the team                 | Any members request                      | `404`; rows unchanged; RLS hides the rows even without the explicit filter                                     | introduced | team-members-routes isolation tests                    |
| Member is erased                                        | `eraseUserFromTenant`                    | Membership rows deleted; the team's positions are closed up so the order has no gap                            | introduced | positions isolation test, erasure coverage tests       |
| Team is soft-deleted                                    | `DELETE /admin/teams/:id`                | Its member rows are deleted (membership is not history); schedule windows are untouched                        | changed    | teams route test                                       |
| Tenant is purged                                        | tenant-purge                             | `team_members` deleted before `teams`                                                                          | introduced | `tenant-purge-full-coverage` isolation test            |
| User asks for their data export                         | Export bundle built                      | Includes the user's team memberships                                                                           | introduced | `user-data-export-coverage-guard`                      |
| Roster window created for a team with members           | `POST /admin/on-call-schedules`          | Primary, backup and escalation manager must be members; otherwise `422` on that field                          | introduced | schedule route and isolation tests                     |
| Old window names a former member                        | `PATCH` without changing that role       | Still `200`; only roles the edit changes are checked                                                           | introduced | "stays editable until that role changes"               |
| Create modal opens before teams finished loading        | Modal renders                            | Dropdown and state agree on a team                                                                             | changed    | roster modal tests                                     |

No change to routing: `resolve_oncall` still reads schedule rows only.

## Decision notes

- Positions stay contiguous (owner request): every replace and every removal renumbers the team,
  because the rotation steps through members by position.
- The people check for a member list covers additions only. Re-checking the whole list made a
  departed member block every later edit of their team (found in `/review`).
- Team edits in the UI are two requests (members, then name/description). Members go first because
  that is the call that can be refused; if the second fails, the UI says the members were saved.
- Beyond the plan-lock's scope paths, `packages/entity-engine/src/user-data-export.ts` also changed:
  the personal-data export guard requires every erased user column to be collected or excluded.

## Review

- `/security-review` (reviewer agent): no blocking or high findings. Low: concurrent member edits could
  collide on the unique index (fixed with a row lock); a team with zero members keeps the old
  any-user rule by design (spec R3), to revisit in PR B.
- `/review` (medium): 10 findings; 4 fixed (additions-only people check and 404-before-Zitadel,
  member change before name change in the UI, empty team dropdown, members removed on team delete).
  Not changed: PATCH null case is unreachable, compaction issues one UPDATE per shifted row (capped at
  100 members), the member cap constant is duplicated in API and UI, a minor memo cost, and no separate
  audit row for erasure.

## Verification

- `pnpm typecheck`: pass (52/52).
- `pnpm lint`: pass (after fixing two `??` findings).
- Unit and route tests: teams routes 32, schedule routes 22, admin-ui teams + roster 16, admin-ui full
  suite 104 files; all pass.
- Isolation, on a throwaway Postgres (migrations 0001–0157 applied): the two erasure coverage guards,
  the user-data export guard, the user-erasure suites, the new positions and routes isolation tests,
  and all tenant-purge isolation files pass. On this Windows host the tenant-purge files need
  `--hookTimeout=120000` (the 10 s default times out while loading).
- Not clean here, unrelated to this diff and not compared against `main`: `upload-flow` and
  `quarantine-flow` (file storage / AV), and `reporting-binding` / `reporting-grants` (reporting role
  and secret not provisioned on the throwaway database).
- Root `pnpm test` was not run: `.env.local` points at the live dev database.

- **Review follow-up (2026-10-29, PrabhuVijit's R1).** `PUT /admin/teams/:id/members` no longer
  trusts the members it read before the Zitadel check: `replaceTeamMembers` now returns the members
  it replaced, read under the team row lock, and the handler rolls back with 409 if someone it
  skipped as "already on the team" has since left. The eligibility check and the write stay two
  steps by design (the Zitadel call must not hold a connection, #952); a role revoked in between is
  an accepted window, and the schedule create and patch re-check membership. Also: a comment on why
  `compactTeamPositions` updates row by row, a cross-reference on the duplicated 100-member cap
  (the UI cannot import `@platform/teams`), the isolation helper filters by tenant, and the
  migration is renumbered `0157_team_members_table` because upstream took 0156 (#1100).
  `main` merged in.
