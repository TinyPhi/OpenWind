## 2026-10-28 — On-call rotation: edit-modal controls, pause, preview, one team per person

**Session type:** implementation after local testing (owner-directed changes on `tushar`)
**PR:** PR B, opened after PR A (#1103) merged.
**Spec:** [oncall-team-rotation](../../specs/oncall-team-rotation.md) R1, R7, R9, R11.

Owner testing of the rebuilt local stack changed how repeating rosters are edited.

| State                                       | Event                                       | Outcome                                                                                                                              | Kind       | Evidence                                                      |
| ------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------- |
| Creating a window                           | Admin enters start and cycle length         | End is calculated, read-only; repeat is a checkbox (the next team member takes over each cycle)                                      | changed    | roster page tests                                             |
| Repeating roster                            | Admin opens a window of it                  | Controls are in the edit modal: repeat checkbox, pause or resume, delete, next window; the separate panel is gone                    | changed    | roster page tests                                             |
| Repeat switched off                         | Admin saves                                 | Asked to keep this window's end or change it                                                                                         | introduced | roster page test                                              |
| Admin pauses a roster                       | `PATCH status: stopped` or `DELETE`         | Windows not yet started (and their notices) are removed, the cursor rewinds, the running window stays; time is free for a new roster | changed    | route unit tests, `on-call-rotations-routes` isolation        |
| Another roster is active for the team       | Admin resumes the paused one                | `409`: one roster runs at a time                                                                                                     | unchanged  | isolation test                                                |
| Window is running now                       | `PATCH` end later or earlier (still future) | Accepted; start, people and a past end are refused with `422`; a finished window cannot be edited                                    | changed    | `on-call-schedules.test.ts` (4 new)                           |
| Length or end of a repeating window changed | `PATCH`                                     | Rotation cycle and next start follow; later unstarted windows removed so the worker remakes them                                     | introduced | isolation "shortening a running window re-plans the rotation" |
| Repeating roster is running                 | Admin views the calendar                    | Up to 12 upcoming windows shown lightly with a dashed outline; click opens a read-only view                                          | introduced | `projectWindows` tests (3), route test, roster page tests (2) |
| Someone is on another team                  | Admin adds them to a team                   | `422` naming the team; the picker does not offer them; they are free once removed                                                    | introduced | teams route test, isolation test, teams page tests (2)        |

**Notes**

- Running-window edits narrow the 3E "future windows only" rule for the end only; the owner decision is recorded in R7.
- Pausing deletes rows for good (with audit entries), unlike a soft delete, so a later resume does not collide with the `(rotation_id, starts_at)` unique index.
- The ADR-016 addendum (A2) still says stopping keeps generated windows and does not mention one team per person; a human needs to update it.
- Local dev data: the one existing rotation was corrected by hand (cycle 3, cursor at its window's end) after the fix.
- Security review of PR B (2026-10-30): no blocking findings. `PATCH /admin/on-call-rotations/:id` now
  locks the rotation row before reading it, so the audit snapshot and the resume check cannot go stale
  against the worker. Known and accepted: the one-team-per-person race (see the spec's open items);
  messages already sent are not retracted when pausing removes a future window.
