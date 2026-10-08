# 2026-10-06 — admin-ui route-level code splitting (1 of 5, split from #772)

**Session type:** Frontend performance
**PR:** split from #772 (slice A of 5: A lazy routes, B request dedup, C hover to CSS, D refactors, E runtime)
**Branch:** `perf/772-a-lazy-routes`

- All 32 page routes are lazy-loaded (`apps/admin-ui/src/lazy-routes.ts`) behind a `Suspense`
  that sits inside the layout, so the sidebar and header stay mounted across navigation. The
  entry chunk goes from about 1,436 kB to about 660 kB raw, across 41 JS chunks.
- `RouteErrorBoundary` keeps the shell usable when a page throws or its chunk is missing: Reload
  for a chunk error, Retry (and a console log) for anything else.
- `vite:preloadError` reloads once after a redeploy, guarded by a 10 s `sessionStorage`
  timestamp so a real outage can't loop.
- `build` now runs `scripts/check-entry-size.mjs` after `vite build`: the entry must stay under
  210 kB gzip (measured 196.9 kB). `chunkSizeWarningLimit` goes from 700 to 680 kB raw.
- `eslint.config.mjs` gives `**/*.mjs` node globals so the size script lints.
- Tests: `lazy-routes`, `route-error-boundary`, `preload-error` and `shell-stability` suites.
- Not in this slice: hover-to-CSS, request dedup, idle-logout, avatars and the refactors (the
  other four PRs from the #772 split).
- Known gap: turbo's `build` cache inputs (`src/**`, `tsconfig.json`, `package.json`) don't
  include `vite.config.ts` or `scripts/`, so a change to only the budget can be served from cache
  without re-running the check. Fixing `turbo.json` is left for a separate PR.
