# Review: `perf/admin-ui-performance-optimizations`

Reviewer assessment of 17 commits (base `origin/main`, merge-base `fc8a519`; the last 2 commits were local-only at review time). 35 files, +2086 / −740.
Method: 4 parallel read-only reviews (bundle, data/network, render/forms, docs+verification), a before/after hook audit script (`scripts/audit-hook-delta.py`), and real builds of base vs. head.

## TL;DR

| Verdict                  |                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real, large win          | Route-level code splitting: entry **1,436 kB → 658 kB raw, 402 → 201 kB gzip (−50% gz)**. Measured by building both refs.                                                                                                                    |
| Real, small              | Users/notifications request dedup, `Promise.all` on record-detail/workflow-records, DiceBear removal (privacy), localStorage guards in theme.                                                                                                |
| Cleanup, **not** perf    | 96 JS hover handlers → CSS (state was already per-row), form-state consolidation. Good for LOC/maintainability; sold as perf.                                                                                                                |
| Overhyped / cosmetic     | `defer` on env.js (~0 effect), `chunkSizeWarningLimit: 700` (silences warning, enforces nothing), idle-logout throttle, context memoization (unmeasured), "−99.9% timers", "450→160 ms", "0 warnings".                                       |
| Needs a fix before merge | Users cache never expires and survives SPA logout; hover CSS regression on accent colour; possible requester access-status regression; workflow-records skip-ref may swallow a filter change; no chunk-load error boundary; dead logo files. |

Tests/gates on the branch: typecheck, lint, vitest (50 files, 372 tests) and build all **pass**. Build still prints the `env.js can't be bundled without type="module"` warning.

Caveat: data and render reviewers read diffs only (did not run the app). Items marked "verify" are suspected, not reproduced.

## Resolution status (follow-up commits on this branch)

Fixed after this review (each as its own small commit):

| Finding                                                                        | Status                                                                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Users cache never expires / survives logout / stale-write race                 | **Fixed**: 60 s TTL, reset on logout via `lib/session-events.ts`, generation guard, failures not cached; tests added                   |
| Requester access-request status regression (list endpoint 404s for non-owners) | **Fixed**: confirmed real (`list-access-requests.ts` returns 404 for non-owners); local/WS-driven override restored, scoped per record |
| workflow-records skip-ref could swallow a filter change                        | **Fixed**: marker is now the exact fetched URL and is consumed on every list-effect run                                                |
| Suspense replaced the whole shell on first route visit                         | **Fixed**: Suspense + error boundary wrap only the `<Outlet/>` inside Layout                                                           |
| No chunk-load failure handling                                                 | **Fixed**: `RouteErrorBoundary` plus a guarded one-time reload on `vite:preloadError`                                                  |
| Selected picker row ignored accent colour                                      | **Fixed**: `color-mix` on `--accent-primary`                                                                                           |
| Dead `ow-logo.png/.svg`, dead `ResolvePreview` alias                           | **Removed**                                                                                                                            |
| Notification in-flight dedup vs. mutations                                     | **Fixed**: mutators and logout clear it; `.finally` no longer nulls a newer request                                                    |
| Idle logout could fire up to ~10 s early                                       | **Fixed**: timeout re-checks the latest raw activity; test added                                                                       |
| `chunkSizeWarningLimit` presented as a guard                                   | **Added** `size:check` (entry gzip ≤ 280 kB, currently ~264 kB); docs corrected                                                        |
| Unverified/incorrect doc claims, hashes, names, AGENTS.md vs `useHoverStyle`   | **Corrected** in `docs/frontend-performance-optimizations.md` and `AGENTS.md`                                                          |

Deliberately **not** changed (needs a product/design decision or is larger scope):

- `Promise.all` in record-detail still fires comments/attachments/tags when the record 404s/403s, with no stale-id guard.
- Hover rules still need `!important` because inline base styles remain; hard-coded hover colours lack a dark variant; `@media (hover: hover)` and `:focus-visible` not added.
- `layout.tsx` unrelated logo/avatar changes not split out of history.
- `useHoverStyle` in `packages/ui` is kept (shared primitive) but now unused by admin-ui.
- Vendor `manualChunks`, CI wiring of `size:check`, and prefetching.

The findings below are the original review text, kept for the record.

## What passes verification

- typecheck / lint / vitest / build green.
- Per-route chunk size table in the docs matches the build output exactly.
- Largest lazy chunk: workflow-detail 309 kB. ~44 lazy chunks total.
- `defer` on `env.js` is **safe**: still ordered before the module entry in built `dist/index.html`; readers in `authProvider.ts:16`, `users.tsx:25`, `api-keys/create.tsx:18` unaffected.

## Per-change assessment

### 1. Route code splitting (`lazy-routes.ts`, `App.tsx`) — GENUINE, biggest win

Base shipped one 1.4 MB chunk; login/dashboard parsed every page. Now ~660 kB entry + on-demand chunks.
Issues:

- **Suspense too high.** Wraps `<Routes>` (`App.tsx` ~L132) while `Layout` is inside the route element, so first visit to any route replaces the whole shell with "Loading…". Move Suspense around `<Outlet/>` inside Layout.
- **No chunk-load error handling.** No error boundary / `vite:preloadError` handler. After a redeploy, an open tab navigating to a lazy route white-screens. This failure mode is _new_ with this branch.
- No prefetch; Login and AuthCallback are lazy too, adding a hop on OIDC return.
- Entry is still 658 kB: vendor `manualChunks` is the obvious next step (not done).
- "Login −99.6%" is misleading: `/login` still loads the 658 kB shell.

### 2. `index.html` defer + `vite.config.ts` size limit — COSMETIC

- Module scripts are already deferred; `defer` ≈ zero perf. Harmless.
- `chunkSizeWarningLimit: 700` is a warning threshold, **not** a budget guard: build never fails on size. Docs call it a "regression guard"; it is not. A real guard needs a CI step (e.g. size-limit or a script asserting entry gzip).

### 3. Avatar/logo (`authProvider.ts`, `layout.tsx`, `public/ow-logo.*`) — GENUINE but trivial

- DiceBear → offline `InitialsAvatar`: removes a third-party request and stops sending user display names to a third party. Real **privacy** win; weak perf claim. Loses per-user colour variety; white text on a possibly light accent; `aria-label` on a plain `div` is ignored by AT.
- Logo 404 fix is correct but trivial.
- **`public/ow-logo.png` is not a PNG**: 297 bytes of SVG, byte-identical to `ow-logo.svg`. **Neither file is referenced** (layout uses `/favicon.svg`). Delete both.
- `theme.ts` safeGet/SetItem: valid robustness fix, unrelated to perf. Still no inline head script to prevent theme flash.

### 4. Users cache + in-flight dedup (`use-users.ts`) — REAL but introduces bugs

- Dedup of concurrent requests is correct (cleared in `.finally`, also on error).
- **`cachedUsers` never expires or invalidates** (`use-users.ts:9-16`); `clearUsersCache` only called from tests. Before: refetch each mount. Now: new/renamed user missing from pickers until hard reload. `users.tsx:236` has its own uncached fetch so doesn't refresh it.
- **Cross-identity leak**: cache not keyed by user. Normal logout (`signoutRedirect`) reloads the page (safe); fallback logout (`authProvider.ts:119`) and idle-logout `navigate("/login")` are SPA navs, so cache survives into the next login in the same tab.
- Shared fetch returns `[]` on failure → callers' `.catch` is dead; `user-ref-picker` no longer rejects. Stale-write race: old in-flight can write cache after `clearUsersCache()`.
- Fix: TTL + invalidate on user mutation + clear on logout/identity change; keep errors distinguishable from empty.

### 5. Notifications dedup (`notifications-client.ts`) — GENUINE, small

Bell and `dashboard.tsx:1046` both fetch on the dashboard: one request saved, one page. Mutators (`markRead`/`markAll`) don't clear in-flight state, so a refetch during an in-flight request can return pre-mutation data. Overhyped as "−50% duplicate requests" (unmeasured, one page).

### 6. `Promise.all` initial loads (`record-detail.tsx`, `workflow-records.tsx`, `workflows/detail.tsx`) — GENUINE, ~1 round trip each, with side effects

- record-detail: comments/attachments/tags now fire even when the record 404s/403s; no stale-id guard on fast navigation.
- workflow-records: **bug candidate** — `initialLoadedWorkflowIdRef` makes the list effect skip once; if `workflowId` doesn't change (slug re-entry) the next filter change is swallowed. Shell effect reads filters from closure while depending on `[workflowSlug]` only. A records 500 now fails the whole page instead of only the board. Record-URL logic duplicated across two effects.
- record-detail: **possible functional regression (verify)** — `myAccessReqStatus` now derived from `accessReqList`, and `setMyAccessReqStatus("pending")` removed. `loadAccessRequests` looks gated to owner/admin, so a plain requester may stay on "none" after requesting. WS handler compares `requestedBy`, memo uses `requesterId`.

### 7. `entity-type-context.tsx`, `use-idle-logout.ts` — OVERHYPED

- Context memo/useCallback: correct deps, stable `reload`; benefit unmeasured.
- Idle throttle: leading-edge, so a dropped trailing event can make logout fire up to ~10 s early (≈3% at 5 min default), never late. Only new test checks `{passive:true}`; throttle itself untested. "−99.9% timers" is not backed by any trace.

### 8. Hover → CSS (96 handlers removed) — CLEANUP, not perf

State was already per-row, so a hover re-rendered one small component. Real gains: no JS on pointer move, ~150 fewer TSX lines, theme vars in CSS. Calling it a perf fix is generous.
Defects:

- **Regression:** `.user-picker-option-row.is-selected` (`index.css:5058`) hardcodes `rgba(0,170,85,.1)`; old code used `var(--accent-primary)1a`, so selected rows no longer follow the user's accent colour. Use `color-mix(in srgb, var(--accent-primary) 10%, transparent)`.
- Drift: record-create selected row bgSecondary → green tint, no hover on selected; org-directory highlighted card no longer changes border on hover; KpiTile `active` no longer animates.
- Inline base `border`/`boxShadow` still beat the new rules, so several classes (`stat-card-interactive`, `module-card-interactive`, `org-card-interactive`, `workflow-drag-handle`) need `!important`: smell. Move base values into the class.
- Hard-coded `#fca5a5`, `hsla(250,84%,60%,.06)` with no dark variant. Near-duplicate classes; mislabelled section comment at `index.css:5050`; 3 trailing blank lines.
- All 17 new classes are used (none dead). No `@media (hover: hover)`, no `:focus-visible` (pre-existing).
- `layout.tsx` mixes unrelated changes (logo, avatar). Split or call out.
- Residual hover JS: `reporting.tsx:401` (tooltip), `record-detail.tsx:4353` (drag end) — legitimate, but contradicts "100% eliminated".

### 9. Form-state consolidation (`schedule-rules`, `notification-policies`, `record-create`) — BEHAVIOUR-PRESERVING, not render-perf

- useState counts: schedule-rules 31→14, notification-policies 21→14, record-create 20→12. No lost fields/validation changes found.
- Every keystroke still re-renders the component. "Derived-state effect removal" **did not happen**: `currentState` effect and `[open, rule]`/`[open, policy]` reset effects remain.
- schedule-rules is best: shared `initialRuleFormData` removes ~80 duplicated lines and a per-render cron parse.
- Inconsistent patterns across the three forms; dead `export const ResolvePreview = ResolveSimulator` (`notification-policies/index.tsx:693`); unused exports of form-data types; awkward `typeof val === "function"` cast in `updateFormField`.

## Docs assessment (`docs/frontend-performance-optimizations.md`, `AGENTS.md`)

Verified true: chunk-size table, bundle direction, gate commands, commit scopes.
Wrong or unsupported:

- "0 warnings": false (env.js warning remains).
- Headline −53.9% is raw size; gzip is −50.0%. Baseline 1,429.22 kB vs actual 1,436.42 kB.
- **Presented as "Measured" with no trace/script/artifact in repo:** 450→160 ms (−64%) waterfall, Profiler hover commits, −99.9% timers, −50% duplicate requests, network-trace 404/DiceBear numbers.
- Nonexistent names: `THROTTLE_INTERVAL_MS` (code is adaptive `Math.min(10_000, max(500, timeout/5))`), `UserAvatarBadge` (it is `InitialsAvatar`).
- 17 commits not 16, hashes in table don't match log; test path is `workflow-records.test.tsx`; base `App.tsx` had 32 page imports, not 31.
- `chunkSizeWarningLimit` described as a guard; it is not.
- `AGENTS.md` bans `useHoverStyle`, but that hook is a deliberate shared primitive in `packages/ui` (#330/#331, week-log 2026-08-05). Branch removes every use but leaves hook + test as dead code, no ADR/week-log entry. AGENTS.md duplicates `CLAUDE.md`/`.claude/rules` and nothing links to it; some rules (no un-narrowed `unknown`, explicit return types on all exports) are stricter than `.claude/rules/code-style.md`.
- Existing `scripts/analyze-react-hooks.py`: runs (67 prod files, 880 hooks; record-detail.tsx 102 useState / 6,324 lines) but docstring promises JSON/Markdown output it never writes, anti-pattern + urgency scores computed but never printed, regex not AST, no baseline so it cannot support any before/after claim.

## Hook / state audit (script)

`scripts/audit-hook-delta.py` compares base vs HEAD per changed non-test file (`python3 scripts/audit-hook-delta.py origin/main`). Regex-based, so counts are approximate.

| Metric                                            | Before |                                                                                   After |    Δ |
| ------------------------------------------------- | -----: | --------------------------------------------------------------------------------------: | ---: |
| useState                                          |    329 |                                                                                     295 |  −34 |
| useEffect                                         |     72 |                                                                                      70 |   −2 |
| effect that only sets state (derived-state smell) |      7 |                                                                                       7 |    0 |
| useMemo                                           |     15 |                                                                                      17 |   +2 |
| useCallback                                       |     15 |                                                                                      18 |   +3 |
| useRef                                            |     35 |                                                                                      36 |   +1 |
| `onMouseEnter/Leave`                              |     97 | 1 (3 lines remain across all of `src`: reporting tooltip ×2, record-detail drag-end ×1) |  −96 |
| inline `style={{}}`                               |    727 |                                                                                     728 |   +1 |
| `lazy()`                                          |      0 |                                                                                      32 |  +32 |
| lines                                             | 25,206 |                                                                                  25,585 | +379 |

Reading: no hook bloat introduced. Growth limited to `entity-type-context.tsx` (+1 useMemo, +3 useCallback, justified), `record-detail` (+1 useMemo for derived status), `workflow-records` (+1 useRef, the skip-ref flagged above). Inline-style count did not drop, so the render-cost story rests on hover handlers only. Hotspots untouched: `record-detail.tsx` (107 useState, 14 useEffect), `workflows/detail.tsx` (54 / 16), `workflow-records.tsx` (34 / 7). The "form-state rule" in AGENTS.md is aspirational for these.

## Does it break existing functionality?

Nothing confirmed broken by tests. Suspected / likely:

1. Requester access-request status after requesting (record-detail) — verify manually.
2. Stale users list after user create/rename (until reload).
3. Users cache across SPA logout → login as another user.
4. Filter change swallowed in workflow-records after slug re-entry.
5. White-screen on lazy chunk 404 after redeploy.
6. Selected picker row ignores custom accent colour.
7. Whole-page failure when records endpoint 500s in workflow-records.

## Future impact

Positive: lazy-route structure is the right foundation; entry now has room for vendor chunking; CSS-class hover pattern is reusable; shared `initialFormData` pattern in schedule-rules is a good template; offline avatar removes an external dependency.
Negative: caches with no invalidation model will keep producing stale-data bugs; unmeasured perf claims in docs set a precedent for unverifiable "Measured" tables; AGENTS.md duplicates and partly contradicts existing rule files; `useHoverStyle` left dead; `!important` hover rules couple CSS to inline styles.

## Recommended before merge

Must fix:

1. Users cache: TTL + invalidation + clear on logout/identity change.
2. Verify/fix requester access-status in record-detail.
3. Fix workflow-records skip-ref/filter closure.
4. Add chunk-load error boundary / `vite:preloadError` reload; move Suspense into Layout around `<Outlet/>`.
5. Accent colour regression on `.is-selected`.
6. Delete `public/ow-logo.png` + `ow-logo.svg`.

Should fix: 7. Correct docs: unmeasured claims → "estimated" or add traces; fix names, counts, gzip numbers, "0 warnings", the budget-guard wording. 8. Real size gate in CI (entry gzip ceiling) instead of `chunkSizeWarningLimit`. 9. Reconcile AGENTS.md with `CLAUDE.md`/`.claude/rules`; remove or ADR the `useHoverStyle` decision. 10. Tests: throttle, error/reject paths, cache invalidation, record-detail/workflow-records loaders. 11. Remove dead `ResolvePreview` alias, unused exports; split `layout.tsx` unrelated changes; reframe hover/form changes as cleanup.

Next: vendor `manualChunks`; `@media (hover: hover)`; keyboard operability of clickable divs/rows.
