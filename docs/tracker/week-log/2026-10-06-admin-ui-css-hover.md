# 2026-10-06 — admin-ui CSS hover states (3 of 5, split from #772)

**Session type:** Frontend performance
**PR:** split from #772 (slice C of 5: A lazy routes, B request dedup, C hover to CSS, D refactors, E runtime)
**Branch:** `perf/772-c-css-hover`

- 24 `useHoverStyle` calls (48 `onMouseEnter` / `onMouseLeave` props) across 11 files are replaced
  by CSS classes and `:hover` rules in `apps/admin-ui/src/index.css`. Hovering no longer triggers
  React state updates or re-renders.
- Theme fidelity is kept through CSS variables and `color-mix()`; per-instance colours (stat card,
  module accent, workflow drag handle) are passed as inline custom properties
  (`--card-color`, `--card-glow`, `--mod-accent`, `--drag-glow`). A selected picker row keeps its
  tint and ignores hover (`.is-selected`).
- Rules that must beat an inline base style use `!important` (stat, module and org cards, drag
  handle). That couples them to the components' inline styles; moving the base styles into the
  stylesheet would remove it. Left as a follow-up.
- `useHoverStyle` remains exported from `@platform/ui` (shared primitive); admin-ui no longer uses
  it. Whether to remove it is a separate decision.
- Needs a visual check in the browser: no automated test asserts hover styling.
- Not in this slice: lazy routes, request dedup, the refactors, idle-logout and avatars (the other
  four PRs from the #772 split).
