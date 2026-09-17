## 2026-09-15 — Ticket form select-field fix + Notification Policy admin UI

**Session type:** Implementation — admin-ui only
**Branch:** `feat/PLAT-611-tagsev-3e-ticket-form-and-policy-ui` (PR 11 of the tagsev/3E+3F stack)

### Context

Continuing docs/specs/oncall-routing.md's Phase 4 (UI/observability surface). This PR covers
two of that phase's tasks:

- **T20** (partial): ticket form UI. `team_id`/`service_id` pickers are **out of scope** —
  `modules/helpdesk/seed/001_entity_types.sql`'s own header comment confirms those two fields
  are deliberately not seeded yet, pending the entity-engine/`packages/teams` dependency-direction
  question tracked in `docs/open-questions.md`. What _was_ in scope and genuinely broken:
  `field-input.tsx` had no case for `fieldType: "select"` at all (only `"enum"`/`"multi_enum"`),
  so `severity`/`priority`/`category` — all seeded as `"select"` — silently fell through to a
  plain text input instead of a dropdown. Fixed by adding `"select"` alongside the existing
  `"enum"` case.
- **Label chips on the ticket detail page**: new `TicketLabelsPanel` component (assign/remove
  via the already-merged `/entities/:id/labels` endpoints from PR #594), wired into
  `record-detail.tsx` next to Attachments.
- **T32**: new `/admin/notification-policies` admin page — severity x team x workflow-type
  policy list with create/edit/delete, plus a dry-run Preview panel against
  `GET /admin/notification-policies/resolve` (no side effects, matching that route's own R20
  contract). Admin-only nav entry + route, consistent with the existing Teams/Services/Roster
  admin-only pages (PR #602, still unmerged at the time this branch was cut from `main`).

### What was produced

- `apps/admin-ui/src/components/field-input.tsx` / `.test.tsx` — `"select"` fieldType case
- `apps/admin-ui/src/components/ticket-labels-panel.tsx` / `.test.tsx` — new component
- `apps/admin-ui/src/pages/customer/record-detail.tsx` — wired in `TicketLabelsPanel`
- `apps/admin-ui/src/pages/notification-policies/index.tsx` / `.test.tsx` — new admin page
- `apps/admin-ui/src/components/layout.tsx`, `apps/admin-ui/src/App.tsx` — nav + route wiring

### Review findings (1, fixed)

- `ticket-labels-panel.tsx`'s `/admin/labels` fetch had no out-of-order-response guard, unlike
  the adjacent `refresh()` fetch's `requestIdRef` pattern two lines above in the same file —
  fixed by reusing the same ref.

### Verification

- `pnpm --filter admin-ui typecheck`: PASS
- `pnpm --filter admin-ui lint`: PASS
- `pnpm --filter admin-ui test`: PASS (39 files, 283 tests)

### Still open (not this PR)

- `team_id`/`service_id` ticket-form pickers, blocked on the entity-engine/`packages/teams`
  dependency-direction decision (`docs/open-questions.md`).
