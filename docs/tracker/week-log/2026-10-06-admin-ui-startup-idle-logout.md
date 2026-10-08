# 2026-10-06 — admin-ui startup and idle-logout hardening (5 of 5, split from #772)

**Session type:** Frontend performance and resilience
**PR:** split from #772 (slice E of 5: A lazy routes, B request dedup, C hover to CSS, D refactors, E runtime)
**Branch:** `perf/772-e-runtime`

- `useIdleLogout` throttles its timer reset to at most one per `min(10 s, max(0.5 s, timeout / 5))`
  and registers its listeners as `passive`. Every event still records `latestActivity`, and the
  timeout re-checks it before logging out, so dropped events never cause an early logout. A
  rejected `logout()` still navigates to `/login`.
- `Layout` renders an `InitialsAvatar` (profile picture when present, otherwise initials on the
  accent colour) instead of requesting `api.dicebear.com`. `getIdentity` no longer builds a DiceBear
  URL. The sidebar logo points at `/favicon.svg`; `/ow-logo.png` was never in `public/`.
- `theme.ts` reads and writes through `safeGetItem` / `safeSetItem`, and `authProvider` catches a
  failing initial `getUser()`, so blocked storage can't break startup.
- `index.html` loads `/env.js` with `defer` (deferred and module scripts run in document order, so
  `window.__CONFIG__` is still set before the app reads it). A CSS comment that closed early and
  caused a `css-syntax-error` warning is fixed.
- `EntityTypeProvider` memoizes its context value (`useCallback` / `useMemo`), so consumers don't
  re-render on every provider render.
- Tests: `use-idle-logout`, `theme` (throwing and undefined storage) and `layout` (avatar) suites.
- Not in this slice: lazy routes, request dedup, hover-to-CSS and the refactors (the other four
  PRs from the #772 split).
