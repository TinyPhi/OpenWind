# 2026-10-12 — Coverage-gap badge on tickets (#571 T19)

**Session type:** Code
**Branch:** `feat/PLAT-571-coverage-gap-badge`

- Added a "No on-call coverage" pill to the ticket detail header (`record-detail.tsx`) for agents and
  admins: the ticket has a team, no assignee, and that team has no active on-call schedule right now.
  UI only; it reads the existing `GET /admin/on-call-schedules/current` (agent/admin), where a team
  with no active schedule has `oncall: null`.
- **Gated on the real role, not `isAdminOrAgent`.** On this page `isAdminOrAgent` also admits the
  parent workflow's admins, who may hold only the `user` role and would get a 403 from that
  endpoint. A test covers a user-role workflow admin; swapping the gate to `isAdminOrAgent` fails it.
- The lookup lives in `lib/oncall-coverage.ts` (single-flight, 60 s TTL, cleared on session end, a
  request started before a clear cannot repopulate it), the same pattern as `use-users`. The component
  makes no request unless the viewer is staff, the ticket has a team, and the ticket is unassigned.
  A failed lookup shows no badge: it is advisory, and the API logs the failure.
- Kept isolated in its own component and hook because `record-detail.tsx` is over 4,000 lines and its
  test mocks throw on any unrouted URL.
- **Limits, by design:** the badge keys on `oncall === null` as the design says. A team whose schedule
  exists but whose primary, backup and escalation people are all unresolvable (the cascade-exhausted
  case `resolve_oncall` also treats as a gap) is not flagged, because the endpoint does not summarise
  that. Lists of tickets are not badged (it would need a lookup per row); the detail page only.
- **Spec correction:** T33 was marked "done (PR #603)", but #603 shipped label chips and the notification
  policy UI. Nothing in `apps/admin-ui` or `apps/api` references `channel_failed`, and #571's own status
  comment already said so. T33 is back to todo.
- **Review (one independent lens; findings checked against the code, then tested):**
  - _Fixed:_ a closed ticket with a team and no assignee would show "No on-call coverage", which is
    misleading because nothing needs routing on it (the spec says "has team_id, no assignee" and is
    silent on state). The badge is now off for a ticket in a terminal state. A ticket whose state is
    not yet among the workflow's states (still loading, or the lookup failed) is treated as unknown
    and gets no badge either, so a closed ticket never flashes one while states load.
  - _Fixed:_ the hook kept a stale set. If a ticket was assigned and then unassigned, it could show a
    set older than the cache TTL until the refetch landed. It now seeds from a fresh cache on the
    first render (as `use-users` does) and drops any older set while refetching.
  - _Fixed:_ several "shows nothing" tests asserted before the lookup's response was handled, so they
    could pass vacuously. They now flush first, and a mutation that makes every team a gap fails them.
  - _Limit, documented:_ `/current` excludes soft-deleted teams, so a ticket whose `team_id` points at
    a deleted team gets no badge, though it can never be routed. The endpoint cannot tell that from an
    unknown team, so telling them apart would need an API change.
  - _Limit, documented:_ the lookup runs when the ticket opens (cached for a minute); a page left open
    for a long time does not refresh the badge.
- Tests: 33 new (cache and hook 15, component 8, page 10). Mutation-checked: the role gate, the
  deleted-ticket and terminal-state exclusions, the unknown-state rule, the assignee check, a missing
  `oncall` counting as a gap, an ignored `enabled` flag, a cache that never expires, a stale pre-clear
  request repopulating the cache, a stale set kept while refetching, a cache not seeded on first
  render, and any team counting as a gap each fail at least one test. Finding the last mutation
  uncaught showed `renderHook` hides the first render's value, so that test now records every render.
