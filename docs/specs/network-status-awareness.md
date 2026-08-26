# Network Status Awareness

> `apps/admin-ui` has no global notion of connectivity — a transport failure dispatches nothing, leaving users with per-page silent failures and no "is it me or the server?" answer. Adds a shared network-status store + banner state, reusing the existing `api:error` banner contract.

status: approved
created: 2026-08-25
updated: 2026-08-25

Design fully authored in [issue #403](../../issues/403) (10 sections: design, browser-compat
matrix, STRIDE review, alternatives considered, delivery shape). This spec adapts that design
into the repo's spec format per the human's decision: phase = Phase-2 UX carry-over, and a
`docs/specs/` entry rather than an ADR (small diff, no schema/contract surface, design already
fully captured in the issue).

---

## §G Goal

- A single module-level store (`network-status.ts`) tracks device-online / server-reachable
  state from three inputs (browser online/offline events, a same-origin health probe, and the
  notifications socket as a corroborating hint only).
- `doFetch()`'s transport-failure catch dispatches an `"offline"` banner event — today it
  throws silently, a real bug independent of the rest of this feature.
- `GlobalErrorBanner` gains a third state ("offline" / "Reconnecting…" / "Back online") on top
  of its existing `"auth" | "server"` kinds, with no behavioral change to the existing two.
- Works correctly across the browser quirks in the issue's §5.2 (background-tab throttling,
  BFCache restore, iOS Safari visibility gaps, Safari's `error`-before-`close` websocket
  ordering) — these are the actual acceptance bar, not just "the happy path renders."

## §C Constraints

| constraint               | value                                                                                                                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack                    | `apps/admin-ui`, React 18, `react-i18next`, Vitest + `@testing-library/react` (all already present)                                                                                                                                                                                     |
| new API route            | none — reuses existing unauthenticated `GET /health`                                                                                                                                                                                                                                    |
| new DB/table/RLS         | none                                                                                                                                                                                                                                                                                    |
| new dependency           | none                                                                                                                                                                                                                                                                                    |
| browser support baseline | `vite.config.ts`'s `build.target: "es2022"` — Chrome/Edge/Firefox/Safari (macOS+iOS); no Playwright/browser-matrix harness exists, so correctness comes from API choice (issue §5.1), not a test matrix                                                                                 |
| out of scope             | write queueing/offline mutation replay (a correctness feature, separate spec); cross-tab probe coordination via `BroadcastChannel` (Safari <15.4 gap — each tab probes independently); a dedicated `/healthz` HEAD route (adds `apps/api` surface for no real benefit — see OQ-1 below) |

## §I Interfaces

- `apps/admin-ui/src/lib/network-status.ts` (new) — module-level store, subscribed via
  `useSyncExternalStore`. Inputs: `online`/`offline` window events (hint), `GET /api/health`
  probe (truth), `subscribeToConnectionState` from `notifications-client.ts` (corroborating
  hint only — never truth, since socket-down also fires on auth/token-expiry, not just network).
- `apps/admin-ui/src/lib/notifications-client.ts` — add exported
  `subscribeToConnectionState(cb: (state: "open" | "closed") => void): () => void`, wired from
  the existing `onopen`/`onclose` handlers. No behavioral change to the socket itself.
- `apps/admin-ui/src/lib/api.ts` — `doFetch()`'s catch block gains the missing
  `dispatchApiError`-equivalent dispatch for transport failures.
- `apps/admin-ui/src/components/global-error-banner.tsx` — `ApiErrorEvent["type"]` extended
  from `"auth" | "server"` to `"auth" | "server" | "offline"`; `role="status"` +
  `aria-live="polite"` added to the banner container (missing today); emoji glyphs get
  `aria-hidden="true"`.
- `apps/admin-ui/src/locales/en/common.json` — new `network` namespace; pre-existing literals
  in `global-error-banner.tsx` ("Log in again", "Dismiss") converted too, per this repo's i18n
  rule (`i18n.ts`'s documented "convert a screen completely in the same pass").

## §R Requirements

R1: Device-offline state is detected and shown distinctly from server-unreachable state
✓ `navigator.onLine === false` → "You're offline" banner, persistent, not dismissible, no auto-timeout
✓ `onLine === true` but the health probe fails → "Reconnecting…" banner, persistent
✓ probe succeeds after either state → "Back online" banner, transient (~4s auto-dismiss, reuses the existing `setTimeout(dismiss, …)` path)
✓ at most one network banner exists at a time (extends the existing "don't stack identical auth errors" de-dup rule)

R2: The health probe is the source of truth; browser/socket signals are hints only
✓ `navigator.onLine` triggers a probe but never sets state alone (LAN/VPN/captive-portal false positives; Firefox's "Work Offline" mode)
✓ websocket close/open corroborates but never sets state alone (auth/token-expiry also closes the socket — using it as truth would show "offline" to a user with a fine connection and an expired token)
✓ probe: `GET /api/health`, no credentials, `cache: "no-store"`, `redirect: "error"` (a captive portal's 302 is a failure), `AbortController` + 3s timeout (not `AbortSignal.timeout()` — Safari <16 gap), success = `res.ok && res.status === 200`

R3: Probing is event-driven, not polled — zero steady-state request cost once healthy
✓ probe fires only on: online/offline event, a transport-level failure from `api.ts`, socket close, `visibilitychange → visible`, and scheduled retries while down
✓ retry backoff is exponential with full jitter (`random(0, min(cap, base * 2^n))`, base 1s, cap 30s — matches the socket's existing ceiling)
✓ probing pauses while `document.visibilityState === "hidden"`; probes immediately on return to visible
✓ once healthy, no timer exists at all

R4: `doFetch()`'s transport-failure path is fixed to actually surface the failure
✓ a network error or timeout in `doFetch()`'s catch dispatches the "offline"/network banner event, where today it dispatches nothing (confirmed bug, independent of the rest of this feature)

R5: Correct behavior across the browser quirks the issue's §5.2 identifies
✓ background-tab timer throttling: pause-on-hidden + probe-on-visible (R3) — the timer is never the only path back to a correct state
✓ BFCache restore (`pageshow` with `event.persisted === true`): forces a re-probe
✓ iOS Safari: also listens to `pagehide`/`pageshow` (more reliable than `visibilitychange` on app switch there)
✓ Safari's `error`-before-`close` websocket ordering: the derived connection-state hint tolerates this as one logical event, not two transitions
✓ debounces ~1.5s before showing any down-state (mobile networks blip sub-second on handoff)

R6: Accessible and internationalized
✓ banner container has `role="status"` + `aria-live="polite"` (not `alert`/`assertive` — an ongoing condition must not interrupt a screen reader mid-sentence)
✓ emoji glyphs get `aria-hidden="true"`
✓ every new string is behind `t()` in a new `network` namespace in `common.json`; pre-existing `global-error-banner.tsx` literals converted in the same pass (no half-converted screen)

## §V Invariants

- The health probe never sends credentials, cookies, or identifiers, and never touches DB/Redis/auth (`/health` is deliberately zero-dependency) — a probe that reports "offline" during a degraded-DB incident would be reporting the wrong fault. Enforced with `credentials: "omit"` on the probe `fetch` — `fetch` defaults to `credentials: "same-origin"`, which attaches cookies on a same-origin request by default; relying on the default would have been a silent violation of this invariant.
- Socket state is a hint, never truth, for connectivity — auth/token-expiry conditions must never be presented to the user as a network problem.
- A screen touched for i18n conversion must be converted completely in the same pass — no mixed `t()`/literal state left behind (existing project-wide i18n rule, reaffirmed here since this PR touches `global-error-banner.tsx`).
- The "recovered" transient banner only fires if a down-state banner was actually shown to the user first — a blip that resolves before the debounce window elapses must resolve silently back to "online", not flash "Back online" for a problem the user never saw.
- A module-level store with `window`/`document` listeners must expose a teardown (`stop()`) — jsdom's `window` persists across tests within a file even when the module itself is reset via `vi.resetModules()`, so an untorn-down previous test's listeners stay live and fire alongside the current test's.

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                                                                                                                   | phase | status | depends    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ | ---------- |
| T1  | `notifications-client.ts`: add `subscribeToConnectionState` export wired from existing `onopen`/`onclose`                                                                                                                                                                                                                                                                                              | 1     | done   | —          |
| T2  | `network-status.ts`: module store + `useSyncExternalStore`-compatible subscribe, probe logic (R2, R3), visibility/BFCache handling (R5)                                                                                                                                                                                                                                                                | 1     | done   | T1         |
| T3  | `api.ts`: fix `doFetch()`'s catch to dispatch the missing transport-failure event (R4)                                                                                                                                                                                                                                                                                                                 | 1     | done   | —          |
| T4  | `global-error-banner.tsx`: add `"offline"` kind + three-state copy (R1), `role="status"`/`aria-live`/`aria-hidden` (R6), i18n conversion of the whole file (R6)                                                                                                                                                                                                                                        | 2     | done   | T2, T3     |
| T5  | tests: `network-status.test.ts` + `global-error-banner.test.tsx` extension — behavioral names per the issue's own list (stays online when onLine flips false but probe succeeds; shows Reconnecting when onLine true and probe times out; no banner for a blip shorter than the debounce window; re-probes on pageshow with persisted true; applies full jitter so two stores don't retry in lockstep) | 2     | done   | T2, T3, T4 |

phase gate: all unit tests pass (`pnpm --filter admin-ui test`) before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                                                                                                                                                                                                                                                                                        | root cause                                                                                                                                                                                                                                                   | promoted to §V? |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| B1  | PR #486 review (blocker): health probe sent the session cookie despite the spec's own no-credentials invariant                                                                                                                                                                                                                                                                                                                                     | relied on `fetch`'s default `credentials: "same-origin"` instead of setting `credentials: "omit"` explicitly                                                                                                                                                 | yes — see §V    |
| B2  | PR #486 review (blocker): `network-status.test.ts` had a latent cross-test listener leak                                                                                                                                                                                                                                                                                                                                                           | module had no teardown export; `vi.resetModules()` gives each test a fresh module instance, but jsdom's shared `window`/`document` still held the PREVIOUS instance's listeners, which kept firing (into orphaned module state) alongside the current test's | yes — see §V    |
| B3  | Found while fixing B2 (not flagged by the review, surfaced once `stop()` made state resets deterministic): "does not show a banner for a blip shorter than the debounce window" started failing — a blip that recovered before the debounce fired still emitted a transient "recovered" banner, because the recovered/online branch was keyed on the internal `serverReachable` flag flipping, not on whether a down-state was ever actually shown | `wasReachable`-based branching didn't distinguish "server was briefly unreachable internally" from "user was shown a down-state" — the debounce is specifically meant to hide a blip from the user, but the recovery path didn't respect that hiding         | yes — see §V    |

---

_spec is source of truth — update as decisions are made_
