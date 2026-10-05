# 2026-10-05 — admin-ui performance: route splitting and review fixes (#772)

**Session type:** Frontend performance + review follow-ups
**PR:** #772
**Branch:** `feat/PLAT-admin-ui-perf-optimizations` (review fixes on `fix/pr772-review-feedback`)

- **What #772 changes:**
  - All 32 page routes are lazy-loaded (`apps/admin-ui/src/lazy-routes.ts`). The entry chunk
    goes from 1,436.4 kB to 661.5 kB raw (401.8 → 197.4 kB gzip), across 42 JS chunks.
  - reactflow and dagre (and their d3 dependencies) load only with the workflow canvas. The
    Superset embed SDK loads only with the Reporting page.
  - Concurrent `/users` and notification requests share one in-flight call, and `/users` is
    cached for 60 seconds. A new session-end hook (`lib/session-events.ts`) resets both on logout.
  - Idle-logout activity listeners are passive and throttled. The timeout is still measured from
    the latest activity.
  - JavaScript hover handlers are replaced with CSS across the layout, pickers and pages.
  - The DiceBear CDN avatar is replaced by a local initials avatar.
  - A route error boundary keeps the shell mounted when a page fails to render or its chunk fails
    to load. A tab left open across a redeploy reloads once (guarded against a reload loop).
- **Review fixes (today):**
  - `workflow-records`: a failed initial record fetch is now retried and its error shown.
    Before, the URL was still marked as loaded, so the board stayed empty with no error.
  - `record-detail`: a failed `/access` refresh keeps the last access list, so the access-denied
    overlay can't drop.
  - `silentRefresh` signals session end only on a confirmed OAuth error. Before, any refresh
    failure (a network error, for example) cleared the session caches.
  - Entry size gate: the budget in `scripts/check-entry-size.mjs` goes from 280 to 210 kB gzip
    (measured 197.4 kB plus ~6%). admin-ui's `build` script now runs the check after
    `vite build`, so the CI build and the Docker image build both fail when it is exceeded.
    `chunkSizeWarningLimit` goes from 700 to 680 raw kB.
  - `AGENTS.md`, the perf reports and the audit scripts are moved out of this PR.
- **Not done:**
  - No workflow file change. The gate runs through `build`, which CI already runs for affected
    packages.
  - turbo's `build` inputs (`src/**`, `tsconfig.json`, `package.json`) don't include
    `vite.config.ts` or `scripts/`. A change to only the budget can therefore be served from
    cache without re-running the check. Changing `turbo.json` is left for a separate PR.
