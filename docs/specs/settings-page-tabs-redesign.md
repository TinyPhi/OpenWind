# Spec: Settings Page — Horizontal Tabs Redesign

**Status:** approved-pending-plan-lock
**Date:** 2026-07-25

## §C Context

`apps/admin-ui/src/pages/settings.tsx` currently renders Appearance,
Notifications (admin-only), and Templates (admin-only) as three stacked
collapsible `data-panel` cards, each independently expand/collapse-able.
User wants a cleaner look: one panel, a horizontal row of switchable tabs at
the top, one section's content shown at a time.

## §R Requirements

- **R1**: Single `data-panel` container. A horizontal tab bar (icon + label
  per tab) replaces the three separate collapsible card headers.
- **R2**: Exactly one tab's content visible at a time; clicking a tab swaps
  the visible content, no page reload, no route change (client-side state).
- **R3**: Tab visibility follows existing admin-gating — Notifications and
  Templates tabs only render (and are only selectable) for `isAdmin`;
  Appearance is available to everyone. If a non-admin somehow has an
  admin-only tab selected in state, fall back to Appearance.
- **R4**: All existing field behavior is preserved as-is — theme/accent
  pickers, the outbound-notifications toggle, the templates-visibility
  toggle list. No change to any API call, loading state, or optimistic
  update logic already in place.
- **R5**: Default selected tab on page load is Appearance.
- **R6**: Existing collapsible-chevron interaction (`appearanceOpen` /
  `notificationsOpen` / `templatesOpen` state) is removed — tabs replace
  expand/collapse entirely.

## §NR Non-Requirements

- No routing changes (no `/settings/:tab` deep links) — this pass is
  client-state only.
- No visual redesign beyond the tab mechanism itself — reuse existing
  `settings-field`/`settings-toggle`/theme/color-palette styles unchanged.

## §I Interfaces

Pure component-internal refactor — no new props, no new API surface. New
CSS classes for the tab bar only (e.g. `.settings-tabs`,
`.settings-tab`, `.settings-tab-active`), added to
`apps/admin-ui/src/index.css` alongside the existing `.settings-*` rules.

## §T Tasks

Single phase — self-contained refactor of one file + CSS additions.

| task                                                                                                                                                          | requirement    | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| T1: Replace `appearanceOpen`/`notificationsOpen`/`templatesOpen` state with a single `activeTab` state; build the tab bar (icon+label, reusing existing SVGs) | R1, R2, R5, R6 | todo   |
| T2: Gate tab availability by `isAdmin`, with fallback to Appearance if the active tab becomes invalid                                                         | R3             | todo   |
| T3: Render only the active tab's existing field content, unchanged                                                                                            | R4             | todo   |
| T4: Add `.settings-tabs`/`.settings-tab` CSS                                                                                                                  | R1             | todo   |
| T5: Manual browser verification (all three tabs, toggle behaviors still work, non-admin sees only Appearance)                                                 | R1-R6          | todo   |

## Acceptance Criteria

| id  | text                                                                                                         | verify                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| AC1 | Only one tab's content is visible at a time; switching tabs is instant, no reload                            | manual browser verification                                              |
| AC2 | Non-admin users see only the Appearance tab                                                                  | manual browser verification                                              |
| AC3 | All existing toggles (theme, accent, outbound notifications, template visibility) still function identically | `pnpm --filter admin-ui test` (existing suites unchanged) + manual check |
