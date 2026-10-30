## 2026-10-28 — Schedule rules page: India default, icon actions, warnings

**Session type:** small UI change after local testing (owner-directed)
**PR:** this one.
**Spec/ADR:** [ADR-017](../../decisions/ADR-017-temporal-scheduler.md) (no change); no spec changed.

| State                         | Event                          | Outcome                                                                                                                      | Kind      | Evidence                                      |
| ----------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------- |
| New rule modal opens          | Admin sees the timezone        | Asia/Kolkata is selected, not UTC; an existing rule keeps its own zone                                                       | changed   | `index.test.tsx` (default, keeps UTC)         |
| Rule list                     | Admin looks at the row actions | Round icon buttons: pause (yellow) or resume (green), edit, delete (red)                                                     | changed   | `index.test.tsx`                              |
| Active rule                   | Admin clicks pause             | A warning explains what happens to missed fire times (catch-up on or off); nothing changes until confirmed                   | changed   | "toggles pause/resume" test                   |
| Paused rule                   | Admin clicks resume            | Resumes straight away, no warning                                                                                            | unchanged | "resumes a paused rule straight away"         |
| Any rule                      | Admin clicks delete            | A stronger warning (removed, created records unaffected, cannot be undone, suggests pausing); deletes only on confirm        | changed   | "warns before deleting" test                  |
| Rule list                     | Admin looks for archive        | No archive button; pausing covers it; the API still accepts `archived` and old archived rules still show                     | removed   | "has no archive button" test                  |
| Rule set to a team (any type) | Rule fires                     | Unchanged: the on-call rules are unscoped (0153) and ship with the core helpdesk module, so every workflow resolves its team | unchanged | dev DB runs on Leave Request and `test` types |

**Notes**

- A comment in `apps/api/src/routes/admin/schedule-rules.ts` wrongly said team routing only works for tickets; corrected, no behaviour change.
- Review follow-up (2026-10-30): the pause and delete warnings no longer say "tickets", because a rule can create any record type. The round buttons use a fixed icon colour (white, and near-black on yellow) instead of the theme's text colour, which was unreadable on yellow in dark mode. `CircleActionButton` defaults to `type="button"`.
