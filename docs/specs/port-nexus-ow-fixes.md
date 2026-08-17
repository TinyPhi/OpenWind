# Port nexus-OW fixes (notification type, event-schema, comments scroll)

> 3 verified, portable fixes from `nexus-OW`/`authnexus-integration` (branch `new`),
> independently re-verified in `tushar` before merge — no AuthNexus/Zitadel dependency.

status: draft
created: 2026-08-17
updated: 2026-08-17

---

## §G Goal

All 3 fixes land in `tushar`, independently tested against THIS codebase's own suite
(not inherited from `nexus-OW`'s verification), then deployed to `~/tms/openwind` server.
Done = migration applied + constraint accepts `entity.unassigned` w/ our own test proving it;
event-schema relaxed w/ bounded length + our own test; comments panel scrolls internally,
confirmed live in our own admin-ui build, no dropdown-clipping regression in Sub-tasks/Linked.

## §C Constraints

| constraint   | value                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Drizzle migration (SQL) + Zod schema (automation-engine) + CSS/TSX (admin-ui)                                                                      |
| auth         | n/a — no auth-surface change                                                                                                                       |
| source       | `owToZita.md` (nexus-OW → OSS port list) — reference only, not trusted as-is                                                                       |
| verification | independent — this repo's own tests, not nexus-OW's                                                                                                |
| out of scope | anything AuthNexus/Zitadel-specific (excluded per source doc); History tab's identical scroll bug (noted, not fixed — separate ticket if reported) |

## §I Interfaces

- `notifications.type` CHECK constraint — add `'entity.unassigned'` (17th value).
- `packages/automation-engine/src/event-schemas.ts` — `assigneeId`, `assignedBy`,
  `previousAssigneeId`, `actorId`, `createdBy`: `z.string().uuid()` → `z.string().min(1).max(255)`.
- `apps/admin-ui/src/index.css` — new `.rcd-comments-scroll` class.
- `apps/admin-ui/src/pages/customer/record-detail.tsx` — comments panel div gets
  `rcd-comments-scroll` in addition to/instead of shared `rcd-tab-scroll`.

## §R Requirements

R1: `notifications_type_check` accepts `'entity.unassigned'`.
✓ New migration file (numbered `0061`, next free slot) applied cleanly against a running
`tushar` DB with all prior migrations already applied — no collision, no manual intervention.
✓ A test inserts a `notifications` row with `type = 'entity.unassigned'` and asserts success
(not just "migration ran" — the actual constraint behavior is proven).
✓ All 16 pre-existing accepted types still insert successfully (no accidental narrowing).

R2: automation event schemas accept non-UUID user ids, bounded in length.
✓ `assigneeId`/`assignedBy`/`previousAssigneeId`/`actorId`/`createdBy` accept a plausible
non-UUID id (e.g. `"12345"`, matching AuthNexus's numeric-string shape) without throwing
`INVALID_EVENT_PAYLOAD`.
✓ Still-valid UUID ids continue to pass (backward compatible with Zitadel's current shape).
✓ Empty string (`""`) is rejected (min(1) enforced).
✓ A string over 255 chars is rejected (max(255) enforced — new bound not present in the
nexus-OW source fix, added here as a deliberate hardening beyond the ported version).

R3: comments tab scrolls internally instead of growing the page.
✓ In a running admin-ui build, a ticket with a long comment thread shows the comments panel
scrolling within its own bounded container (320px–640px height per breakpoint), not
expanding page height.
✓ Panel auto-scrolls to the latest comment on open (existing `commentsScrollRef` effect
becomes live, not just present-but-inert).
✓ Sub-tasks and Linked tabs are independently re-verified (not just trusted from the source
doc) to have no absolutely-positioned dropdown/menu that this change could clip — checked
directly against `tushar`'s current `record-detail.tsx`, since it may have diverged from
the file state `nexus-OW`'s fix was verified against.

## §V Invariants

- A Postgres CHECK constraint enum must be updated in the same change as any new value used
  in application code that writes to that column — a mocked-DB unit test cannot catch this
  class of bug (carried over from `owToZita.md §1`'s lesson, promoted here since it's a
  recurring risk class, not a one-off).
- Any relaxation of an id-shape validation (UUID → generic string) must pair a lower bound
  (non-empty) with an upper bound (reasonable max length) — never relax to fully unbounded.
- UI fixes ported from a sibling worktree are re-verified against the _receiving_ codebase's
  current file state, never assumed identical just because the source worktree shares history.

## §T Tasks

| id  | task                                                                               | phase | status | depends  |
| --- | ---------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | Diff current `notifications_type_check` (16 values) vs required 17                 | 1     | done   | —        |
| T2  | Write migration `0061_notifications_entity_unassigned_type.sql`                    | 1     | todo   | T1       |
| T3  | Test: insert `entity.unassigned` notification row succeeds                         | 1     | todo   | T2       |
| T4  | Relax 5 fields in `event-schemas.ts` to `.min(1).max(255)`                         | 2     | todo   | —        |
| T5  | Test: non-UUID id accepted, empty string rejected, >255 chars rejected             | 2     | todo   | T4       |
| T6  | Add `.rcd-comments-scroll` CSS class                                               | 3     | todo   | —        |
| T7  | Apply class to comments panel div in `record-detail.tsx`                           | 3     | todo   | T6       |
| T8  | Independently verify Sub-tasks/Linked have no clippable dropdown                   | 3     | todo   | T7       |
| T9  | Live verification: rebuild admin-ui, confirm scroll + auto-scroll-to-bottom behave | 3     | todo   | T8       |
| T10 | Run `pnpm typecheck && pnpm lint && pnpm test` across touched packages             | 4     | todo   | T3,T5,T9 |
| T11 | `/security-review` (touches DB constraint + validation schema)                     | 4     | todo   | T10      |
| T12 | Commit + push to `tushar`, then deploy to `~/tms/openwind` server                  | 5     | todo   | T11      |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed                                                                                  | root cause                                                                 | promoted to §V? |
| --- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------- |
| B1  | 7th notification type (`entity.unassigned`) missed on `nexus-OW`'s first constraint-fix pass | CHECK constraint enum silently drops writes; not caught by mocked-DB tests | yes — see §V    |

---

_spec is source of truth — update as decisions are made_
