# On-call: real teams and a recurring rotation

> Teams get members; the on-call roster picks only from the chosen team; a roster can repeat on its
> own, rotating primary and backup through the team, with a 2-day heads-up. For team admins.

status: in progress (PR A in review; PR B built locally, waits on PR A)
created: 2026-10-28
updated: 2026-10-27

---

## §G Goal

Today a team is a name with no members, the roster modal picks three people from the whole org, and
every window is made by hand. After this: an admin builds a team from org users, the roster modal
offers only that team's members, and "repeat every N days" keeps the roster going by itself --
primary and backup move to the next member each cycle -- while the next people are told two days
ahead. Delivered as two PRs, each off `main`, none stacked: **PR A** (members + restricted modal),
**PR B** (recurring rotation + notice).

**Prerequisite (met):** ADR-016 lists "Recurring roster templates" as a deferred decision and had no
team-membership concept. The human-authored ADR-016 addendum (2026-10-28) records both; Claude did
not write the ADR.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Hono API, Drizzle + Postgres (RLS), BullMQ worker, admin-ui (Refine/shadcn)                                                                                                                                                                                                                                                                                                                                                                                                             |
| tenancy      | every new table is tenant-scoped: `tenant_id NOT NULL`, RLS, explicit `WHERE tenant_id`, isolation tests (ADR-001)                                                                                                                                                                                                                                                                                                                                                                      |
| users        | user references are Zitadel `sub` strings (no local users table); validated in the app layer against the tenant, never by FK (db-conventions)                                                                                                                                                                                                                                                                                                                                           |
| eligibility  | a team member is an org user who may be on call: roles `admin`, `agent`, `user` (`ONCALL_ROLES`), the same set the roster pickers use today                                                                                                                                                                                                                                                                                                                                             |
| resolver     | `resolve_oncall` and `GET /admin/on-call-schedules/current` keep reading `on_call_schedules` rows only; a generated window is an ordinary row, so routing needs no change                                                                                                                                                                                                                                                                                                               |
| time         | windows are UTC instants; a cycle is N x 24 h; no DST adjustment (ADR-016 deferred item)                                                                                                                                                                                                                                                                                                                                                                                                |
| worker       | the rotation worker follows ADR-017's pattern: DB polling, `FOR UPDATE SKIP LOCKED` claim, tenant active/trial guard, imported by the worker entry point (`worker-entry-wiring.test.ts`). It polls rotations across tenants, which RLS hides from a worker with no tenant context, so it needs its own narrowly scoped database role with column-scoped grants (as `outbox_sweeper` and the schedule sweeper have) and no more; that role is part of the design and of the ADR addendum |
| cadence      | the worker runs every `ONCALL_ROTATION_TICK_INTERVAL_SECONDS` (default 300), so a window is created at most one interval after it comes due; the 2-day notice lead leaves ample room for that lag                                                                                                                                                                                                                                                                                       |
| out of scope | skills/shift-pattern templates, per-service rotations (ADR-016 OQ-1), follow-the-sun or multi-timezone rotations, SMS/WhatsApp/voice notice, shift-swap requests, PagerDuty/OpsGenie, auto-filling coverage gaps, rotating the escalation manager, a `team_members` link to the org-directory tree                                                                                                                                                                                      |

## §I Interfaces

```
-- PR A
GET    /admin/teams                         -> each team now carries `members: [{ userId, position }]`
POST   /admin/teams                         -> body adds optional `memberUserIds: string[]` (ordered)
PUT    /admin/teams/:id/members             -> { memberUserIds: string[] } replaces the ordered list
POST   /admin/on-call-schedules             -> primary/backup/escalation must be members of `teamId` (R3)
PATCH  /admin/on-call-schedules/:id         -> same rule, for roles being changed

-- PR B
POST   /admin/on-call-schedules             -> body adds optional `repeat: { cycleDays }` (R5)
GET    /admin/on-call-rotations?teamId      -> rotation state: cycle, status, next window, who is next
PATCH  /admin/on-call-rotations/:id         -> { status: "active" | "stopped", endsOn?: date | null }
DELETE /admin/on-call-rotations/:id         -> stops it; generated windows stay
```

New tables (names provisional until the ADR addendum):

- `team_members(id, tenant_id, team_id, user_id text, position int, created_at)` -- unique
  `(team_id, user_id)`, unique `(team_id, position)`; hard-deleted rows (membership is not history).
- `on_call_rotations(id, tenant_id, team_id, cycle_days int, status text, ends_on date null,
blocked_reason text null, next_starts_at timestamptz, last_primary_user_id text,
last_backup_user_id text null, escalation_manager_user_id text null, created_by text, created_at,
updated_at)` -- at most one `active` per `(tenant_id, team_id)` (partial unique index). The three
  `last_*`/`next_starts_at` columns are the rotation's cursor (R5, R6).
- `on_call_schedules.rotation_id uuid null` -- links a generated window to its rotation; a partial
  unique index on `(rotation_id, starts_at)` makes generating a window exactly-once.
- `on_call_schedule_notices(id, tenant_id, schedule_id, user_id text, role text, sent_at)` --
  unique `(schedule_id, user_id, role)`; the exactly-once guard for R8.

## §R Requirements

### PR A -- team members and the restricted roster modal

R1: A team has an ordered list of members chosen from the org's eligible users.
✓ The team create form takes the name, description and members, and the members can be reordered;
creating with members is one request and either all of it persists or none.
✓ An admin can add, remove and reorder members of an existing team later; the new order is what the
team page and every later read shows.
✓ A user who is not an eligible org user (wrong role, not in this org, another tenant's user) or a
duplicate is refused with a field-level `422`; a user id from another tenant is never confirmed to
exist (same rule as `validateCrossTenantRefs`).
✓ A team has at most 100 members.
✓ A team with no members stays valid; every existing team starts with none.
✓ When a user is erased or leaves the org, their membership rows are deleted with the rest of their
data (the erasure path), so no later roster or rotation can pick them.
✓ Removing a member never deletes or rewrites existing schedule windows: history stays intact.
✓ A person is on one team at a time (added 2026-10-28, owner decision): adding someone who is already
on another live team is refused with a field-level `422` naming that team, on create and on `PUT
members`; only people being newly added are checked. The team form's picker offers only people who are
not on another team, so someone removed from a team is free for another.

R2: The team page shows who is on each team.
✓ Each team lists its members by display name in rotation order, and the member picker offers only
eligible users (the same source as the roster pickers, `GET /admin/members`).

R3: The roster modal picks the team first, then the three roles from that team's members only.
✓ Primary is required; backup and escalation manager are optional; each picker lists only the chosen
team's members, and changing the team clears and reloads them.
✓ The server enforces it, not only the form: a role held by a non-member of `teamId` is refused with
a field-level `422`.
✓ Editing a window changes nothing about who may hold it: the rule applies only to roles the edit
changes, so a former member can stay on a window until someone changes that role.
✓ A team with no members keeps the old behaviour (any eligible user) and the modal says that adding
members restricts the choice.
✓ Unchanged from today: a person may hold more than one role in a manually made window (a small team's
admin can be both primary and escalation manager). Only the rotation avoids it (R5).

### PR B -- recurring rotation

R4: A roster can repeat every N days, rotating through the team.
✓ The modal has "Repeat every N days" (default 7, whole days from 3 to 90). Saving creates the first
window with exactly the people the admin picked and one rotation for the team, tied to it; every later
cycle advances from those people (R5). With it off nothing changes from today.
✓ A team has at most one active rotation; creating a second is refused with `409`.
✓ A rotation needs at least one member; with exactly one member it has no backup; with none it is
refused with `422`.
✓ Windows are back to back: each starts exactly when the previous one ends and lasts N days.

R5: Each cycle the next people take over.
✓ The next window's primary is the member after the previous window's primary in team order,
wrapping from last to first; its backup is the member after the previous backup the same way. With no
previous backup (a first window without one) the backup is the member after the new primary.
✓ If that makes primary and backup the same person (a team of two, or after membership changes), the
backup moves on to the following member; with one member there is no backup.
✓ "Previous" is the rotation's latest window that still exists, so an admin's edit to it carries
forward (R7); when none exists it is the rotation's stored last assignment.
✓ If the previous holder is no longer a member, the member at the start of the list takes over (a
removed member's old place is not kept), skipping whoever already holds the other role.
✓ The escalation manager is carried over unchanged; if they are no longer a member the field is left
empty rather than keeping an outsider.

R6: The next window is created on its own, ahead of time.
✓ It is created once the current window is within the notice lead (2 days) of ending, so it exists
at least two days before it starts; it is created exactly once even with several worker instances or
a rolling deploy.
✓ After a worker outage it steps through every missed cycle in order, each with its own rotation step
(R5), up to 52 steps per run, and logs when the cap stops it. It creates a row only for a window that
has not ended yet; a cycle that is already over is stepped past without a row, so history is never
back-filled.
✓ Nothing is generated past an `ends_on` date, for a stopped rotation, or for a deleted team.
✓ If a manually created window overlaps the one it would create, the rotation stops generating, is
marked blocked with the reason, and shows that on the roster page; it never overwrites or shortens the
manual window, and it resumes when the admin clears the overlap.

R7: Admins stay in control of every window.
✓ A generated window can be edited or deleted like any other (swapping people, shifting its end); the
next cycle advances from the latest window that still exists, so an edit changes everything after it.
✓ A window that is running now may have its end moved (still in the future) and its label changed; its
start and people are locked, and a finished window cannot be edited (2026-10-28, narrows the old
"future windows only" rule for the end only).
✓ Changing the length or end of a repeating window re-plans the rotation: windows not yet started are
removed (and their notices), the next window starts at the new end, and a whole-day length (3-90)
becomes the rotation's cycle, so the preview and the worker agree with the edit.
✓ Windows are created with the cycle length as their length; the end is calculated from the start and
the cycle, read-only in the modal, and editable only for a window made before cycles existed or when a
repeat is switched off and the admin chooses to change this cycle's end.
✓ A deleted window is not regenerated: it leaves a gap exactly as a manual deletion does today (no
auto-fill), and the rotation carries on with the following cycle. To cancel the repeat, stop the
rotation (R9).

R8: The people taking over are told two days ahead.
✓ When a window is generated, its primary, backup and escalation manager each get one in-app
notification, and the email the notification pipeline already sends: team name, their role, and the
window's start and end ("You will be primary on call for <team> from <start> to <end>").
✓ Each (window, person, role) is notified at most once, however often the worker runs or restarts.
✓ A window created with less than two days to its start (the first window, or catch-up) notifies at
creation. A window that has already started is never announced.
✓ If an admin changes a person on a window that has not started, the new person is notified once; the
person removed is not.
✓ A failed notification is logged and retried on the next run, and never blocks generating windows.
✓ A tenant whose trial ended or that is suspended gets no generation and no notices (the same guard
as the other workers).

R9: A rotation can be stopped, ended and seen.
✓ An admin can pause a rotation: none are added, the windows that have not started are removed (with
their notices), and the window running now stays until it ends. The time is then free, so another
roster can be created for the team; resuming is refused (`409`) once another rotation is active, so
one roster runs per team at a time. Pausing is reversible otherwise, and resuming continues from the
end of the running window with no gap.
✓ All rotation controls live in the roster edit modal (no separate panel): a Repeat automatically
checkbox, a pause or resume button (pause asks for confirmation with the consequences), a delete button
whose warning says a deleted repeating window leaves a gap, the next window and who is next, and a
blocked reason. When repeat is switched off the modal asks whether to keep this window's end or change
it. The end date for a rotation is no longer exposed in the UI (the API still accepts it).
✓ The roster page marks windows that belong to a rotation.

R11: Upcoming windows of a running rotation are previewed.
✓ `GET /admin/on-call-rotations` returns up to 12 projected windows for an active, unblocked rotation
(same rules as generation, stopping at the end date or an empty team); none for a paused or blocked one.
✓ The roster calendar draws them lightly with a dashed outline, and clicking one opens a read-only
view with the dates and the primary, backup and escalation manager. They are a prediction, never
stored.

### Both

R10: Changes are audited and tenant-safe.
✓ Team member changes, rotation create, stop, resume and end-date changes, and each generated window
write audit entries (generated windows with a system actor and the rotation's creator as owner).
✓ Every new table has RLS and an isolation test that crosses tenants; the new user-id columns are
wired into per-user erasure and tenant purge (or exempted with a reason), and the two coverage guards
pass.

## §V Invariants

- On-call routing never reads team membership or rotations: it reads `on_call_schedules` windows
  only, so a rotation bug can leave a gap but can never mis-route a ticket to a non-member.
- The no-overlap rule for a team's windows (GIST exclusion) stays the only authority: generation
  respects it and never relaxes or works around it.
- A generated window is created exactly once (unique `(rotation_id, starts_at)`) and a notice is sent
  at most once per (window, person, role) (unique key): both are guarded by a constraint, not by worker
  timing.
- The rotation worker's cross-tenant database role (`oncall_rotation_sweeper`) can only read the six
  columns of `on_call_rotations` it needs to find active rotations; it writes nothing. Generation, the
  cursor update and notices run in a normal tenant-scoped transaction.
- A user reference is validated against the tenant in the application layer; a failure is a `422`,
  never a `403` or an existence leak.
- Removing a member, deleting a team or stopping a rotation never deletes a schedule window.
- The worker acts only for tenants that are active and not past trial.
- Team positions are contiguous from 0 after every edit and every removal, and concurrent member edits
  of one team are serialized by a lock on the team row.
- Saving a team's members checks only the people being added against live on-call roles; someone
  already on the team never blocks an edit.
- A generated window is inserted with its (rotation_id, starts_at) conflict target named, so any other
  conflict (such as a manual window) raises and rolls back instead of silently skipping a cycle.

## §T Tasks

Each PR runs Plan -> Code -> Review -> Docs -> Ship on its own branch off `main`; PR B starts after
PR A merges (or is replayed with `rebase --onto`, as with the branding work). Phase gate: unit and
integration tests pass before the next phase; isolation tests in every phase that adds a table or route.

### PR A -- `feat/oncall-team-members`

| id  | task                                                                                                                                               | depends |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| T1  | Migration: `team_members` (+ RLS, indexes, analytics annotation, down); tenant-purge and user-erasure wiring, seed fixture row                     | ADR     |
| T2  | `@platform/teams` + `/admin/teams`: members on read, `memberUserIds` on create, `PUT /:id/members`; eligibility and duplicate checks; audit; tests | T1      |
| T3  | `/admin/on-call-schedules` create and patch: roles must be members of the team (changed roles only); "two roles, one person" check; tests          | T2      |
| T4  | admin-ui teams page: create with members, edit members, reorder, member names in the list; tests                                                   | T2      |
| T5  | admin-ui roster modal: team first, then the three pickers from that team's members, hint for member-less teams; tests                              | T3, T4  |
| T6  | Isolation tests (members across tenants, non-member role refused, erasure guards); `/security-review`; docs (week-log, tracker, this spec)         | T5      |

### PR B -- `feat/oncall-rotation`

| id  | task                                                                                                                                                                                                                                                                                                                                             | depends  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| T7  | Migration: `on_call_rotations` (with cursor), `on_call_schedules.rotation_id` + unique `(rotation_id, starts_at)`, `on_call_schedule_notices`, the rotation worker's sweeper role and column-scoped grants, audit action list; tenant-purge and erasure wiring; `ONCALL_ROTATION_TICK_INTERVAL_SECONDS` in `@platform/config` and `.env.example` | PR A     |
| T8  | `@platform/teams`: pure rotation functions (next assignment with wrap, collision skip, departed-member rule, window generation with cap) and unit tests                                                                                                                                                                                          | T7       |
| T9  | API: `repeat` on schedule create, `/admin/on-call-rotations` list/patch/delete, one-active-per-team `409`, member-count rules; tests                                                                                                                                                                                                             | T8       |
| T10 | Worker `oncall-rotation-worker`: claim as the sweeper role, generate, overlap-block, catch-up (steps without back-filling), notices (in-app + email), tenant guard, entry wiring; tests for R5, R6, R7 (edit carries forward, delete leaves a gap) and R8                                                                                        | T8, T9   |
| T11 | admin-ui: "Repeat every N days" in the modal, rotation markers on the roster page, rotation panel (status, next window, who is next, stop/resume/end date); tests                                                                                                                                                                                | T9       |
| T12 | Isolation tests (rotations, notices, the sweeper role's reach, generation under concurrent claims, blocked overlap); `/security-review` (new cross-tenant role); docs                                                                                                                                                                            | T10, T11 |

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                     | root cause                                                                                                                                                                 | promoted to §V?                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| B4  | `notifications.type` is a database CHECK enum; a new notice type is rejected by the database and invisible to mocked tests                                      | found during design from migration 0104's history, not from a failure                                                                                                      | yes (worker tests run on a real database) |
| B5  | Review: a bare `ON CONFLICT DO NOTHING` also swallows the no-overlap exclusion error, so a manual window created after the clash check silently skipped a cycle | the insert named no conflict target                                                                                                                                        | yes                                       |
| B6  | Review: a stopped rotation of a deleted team could be resumed and then did nothing                                                                              | resume checked members but not the team                                                                                                                                    | no                                        |
| B1  | `user-data-export-coverage-guard` failed after `team_members.user_id` joined the erasure inventory                                                              | the §T1 wiring list named purge and erasure only; a new user-id column also needs a section in the personal-data export (`packages/entity-engine/src/user-data-export.ts`) | no (the guard enforces it)                |
| B2  | `tenant-purge.test.ts` mock of `@platform/db` lacked `teamMembers`                                                                                              | hand-listed table names in that mock                                                                                                                                       | no                                        |
| B7  | Editing a repeating window's length left the rotation's cycle and cursor stale, so the preview still used the old cycle                                         | the window edit did not touch the rotation                                                                                                                                 | yes, see R7                               |
| B3  | Review: PUT members re-checked everyone against live Zitadel, so a departed member blocked every edit                                                           | the eligibility rule applied to the whole list, not to additions                                                                                                           | yes, see §V                               |

## Open items (for the human ADR addendum and review)

- ADR-016 addendum: team membership as a table; recurring rosters moved from Deferred to decided;
  the rotation worker as a new DB-polling job (ADR-017 pattern).
- Table and column names above are provisional, and the sweeper role's name and exact grants are
  part of the addendum.
- Whether `admin_audit_log`'s action CHECK needs widening for the new audit actions (check the
  constraint's current list at T1/T7, as 0140 and 0145 did).
- Spec review 2026-10-28 (fixes applied): a deleted window is not regenerated; catch-up does not
  back-fill past windows; the "one person, two roles" rule was dropped (not enforced today); a team is
  capped at 100 members; the worker interval is configurable (default 300 s).
- Known gap: the one-team-per-person check (R1) runs in its own transaction and `team_members` has no unique index on (tenant, user), so two admins adding the same person to two teams at the same moment can both pass; a unique index or an advisory lock would close it.
- Defaults chosen with the owner on 2026-10-28: escalation manager fixed; notice in-app and email,
  once, 2 days ahead, lead fixed at 2 days for v1; rotation continues from admin edits; member-less
  teams keep the old behaviour; cycle minimum 3 days; stop with optional end date.

---

_spec is source of truth -- update as decisions are made._
