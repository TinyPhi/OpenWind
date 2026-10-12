# 2026-10-06 — admin-ui refactors: shared helpers, form state, access state (4 of 5, split from #772)

**Session type:** Frontend refactor
**PR:** split from #772 (slice D of 5: A lazy routes, B request dedup, C hover to CSS, D refactors, E runtime)
**Branch:** `perf/772-d-refactors`

- Shared helpers: `withAlpha` / `avatarColor` (`lib/theme.ts`), `toWorkflowSlug` / `initials` /
  `singularize` / `formatFieldValue` (`lib/format.ts`) and `useOutsideClick`
  (`hooks/use-outside-click.ts`) replace private copies in about 20 files. Behaviour differences:
  the users and roster avatars change colour (shared hash-to-HSL instead of an 8-colour palette),
  and `useOutsideClick` keeps its listener attached for the component's lifetime. `record-create`
  still has its own `initials`, `singularize` and `useOutsideClick`.
- Form state: `record-create` (`RecordCreateFormData`), `schedule-rules` (`RuleFormData`) and
  `notification-policies` (`PolicyFormData`, `SimulatorFormData`) hold their fields in one typed
  object. No intended behaviour change; existing tests pass unchanged.
- Ticket access state: `accessDenied` and the requester's status are `useMemo` values instead of
  `useState` synced by effects. A failed `/access` request during a silent refresh keeps the last
  good access list, and the list is cleared on record-id change.
- Tests: `format`, `theme-helpers`, `use-outside-click`, and new `record-detail` cases for the
  overlay (silent refresh failure, approval lifting it, no carry-over between records) and a
  non-owner requester's status.
- Merge note: `record-detail.tsx` is also edited by the request-dedup (2 of 5) and hover (3 of 5)
  PRs, and `CHANGELOG.md` by all five, so whichever lands later needs a small rebase.
- Not in this slice: lazy routes, request dedup, hover-to-CSS, idle-logout and avatars (the other
  four PRs from the #772 split).
