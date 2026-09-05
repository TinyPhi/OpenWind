# Hosted Ticket-Create Handoff

> 3rd party opens a new tab to OpenWind's own login+create page w/ workflow+prefill data; user logs
> in (real OpenWind acct) if needed, lands on a pre-filled create-ticket form, creates it themselves.

status: review
created: 2026-08-31
updated: 2026-09-02 — amended for docs/specs/third-party-api-origin-tagging.md R2: entry URL
gains a required `appClientId` param (§I), creation is now rejected outright without a valid one
(new R7, new §V invariant)

---

## §G Goal

3rd party integration can send its end user (who has a real OpenWind login) straight to a
pre-filled ticket-creation screen w/ one click/link — no re-typing workflow/title/remark, full
native upload UX, no new API surface, no redirect-back to the 3rd party.

## §C Constraints

| constraint     | value                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack          | apps/admin-ui (React, react-router-dom, oidc-client-ts via `userManager`)                                                                                                                                                                                                                                                                                                                                                                                   |
| auth           | REAL OpenWind login required (Zitadel, admin-ui's own flow) — explicit product decision, NOT the ADR-012 acting-person/dual-identity model. No auto-login, no SSO-passthrough.                                                                                                                                                                                                                                                                              |
| data transport | `state` param on `userManager.signinRedirect()` (oidc-client-ts) — round-trips through the full OAuth redirect chain automatically. No sessionStorage, no server-side cache.                                                                                                                                                                                                                                                                                |
| out of scope   | Any redirect BACK to the 3rd party after creation (deliberate — avoids open-redirect surface entirely). Any new public API route. Any signed/tamper-proof token scheme (unnecessary — see §V).                                                                                                                                                                                                                                                              |
| out of scope   | Auto-submitting the ticket without the user reviewing/clicking Create themselves.                                                                                                                                                                                                                                                                                                                                                                           |
| existing code  | `apps/admin-ui/src/pages/login.tsx`, `apps/admin-ui/src/pages/callback.tsx`, `apps/admin-ui/src/pages/customer/record-create.tsx` (route `/records/:typeSlug/new`)                                                                                                                                                                                                                                                                                          |
| privacy        | `title`/`remark` travel as GET query params (into `state`, which itself round-trips via URL-embedded OAuth params) — they WILL appear in browser history and any web-server/proxy access logs along the redirect chain. Accepted tradeoff for this feature (same exposure class as any URL-based deep link) — do not put field types tagged `sensitivity: pii`/`financial` (§1.7) through this path; text-only, low-sensitivity fields (title/remark) only. |
| url length     | Practical URL length ceiling ~2000 chars in some browsers/proxies — `remark` prefill is best-effort, not guaranteed for arbitrarily long text. Not a hard requirement to solve here (R5 covers the fallback).                                                                                                                                                                                                                                               |

## §I Interfaces

**Entry URL** (opened by the 3rd party in a new tab):

```
{adminUiUrl}/login?workflowId={uuid}&entityTypeId={uuid}&title={text}&remark={text}&appClientId={id}
```

`workflowId`/`entityTypeId` come from the 3rd party's own prior `GET /workflows` call (already
returns both — see `docs/third-party-api-design.md`). `title`/`remark` are freeform, optional.

`appClientId` (**added 2026-09-02, required** — docs/specs/third-party-api-origin-tagging.md R2)
is the OIDC Client ID of the 3rd party's own registered `api_keys` row (the same value the
application already has from its own key-management setup — not a new credential to obtain).
Unlike `title`/`remark`, this is NOT freeform/unverified: the server validates it resolves to a
real, active, non-revoked `api_keys` row before the create page will let the user submit (§R R7).
This is what lets the resulting ticket carry a `Redirected · [AppName] · [PerformerUsername]`
tag — see the origin-tagging spec's §C for why `oidcClientId` specifically (not `applicationName`,
not the key's own row id) is the stable reference used.

**`state` shape** threaded through `signinRedirect`/`signinCallback`:

```ts
{ workflowId?: string; entityTypeId?: string; prefillFields?: Record<string, string>; appClientId?: string }
```

**`login.tsx` prompt behavior (resolves review blocker 1):** `handleLogin()` currently always
calls `signinRedirect({ prompt: "login" })` — `prompt: "login"` forces Zitadel to show the login
form even with a valid existing session, which would make R1's "already-logged-in user skips the
login screen" criterion false as originally written. Resolution: when prefill query params are
present, call `signinRedirect({ state: {...} })` WITHOUT `prompt: "login"` — the default
(no-prompt) behavior lets the IdP silently reuse an existing session and immediately redirect back
through `/auth/callback` with no user-visible login form. Confirmed reachable: the app has no
route guard that redirects an already-authenticated user away from `/login` before this logic
runs (`App.tsx`'s `/login` route renders unconditionally) — an already-logged-in user hitting the
entry URL still executes `login.tsx`'s query-param-read logic, it just resolves near-instantly.

**`entityTypeId` → `typeSlug` resolution (resolves review blocker 2):** `EntityTypeProvider`
(`apps/admin-ui/src/entity-type-context.tsx`) only wraps the authenticated app shell
(`App.tsx:109-113`) — it does NOT wrap `/login` or `/auth/callback`, so that context is not
available at `callback.tsx`'s point in the tree. Decision: `callback.tsx` calls
`fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}`)` directly (same `fetchWithAuth`/
`API_URL` utility already imported by `record-create.tsx` and `entity-type-context.tsx`, from
`./lib/api.js`) to resolve the slug itself — a plain function call, not dependent on any
provider being mounted.

**Post-login navigation** (`callback.tsx`, replacing the current unconditional
`navigate("/dashboard")`):

- no `state.workflowId` → unchanged: `navigate("/dashboard")`
- `state.workflowId` present → resolve `entityTypeId` → slug via the direct `fetchWithAuth` call
  above → `navigate('/records/${slug}/new', { state: { workflowId, entityTypeId, prefillFields } })`
- `state.workflowId` present but the `fetchWithAuth` lookup fails/404s (bad `entityTypeId`) →
  falls through to the unchanged `navigate("/dashboard")` path (R5)

**`record-create.tsx` addition**: extend its existing `routeState` type with `prefillFields?:
Record<string, string>`; seed `fieldValues` from it once `fields` (the workflow's schema) has
loaded, keyed by field `name` — same union already used for `workflowId` preselect.

## §R Requirements

R1: A 3rd party can open a link that, after the user logs in (or immediately, if already logged
in), lands them on that workflow's create-ticket form with the given `title`/`remark` values
already filled in.
✓ Logged-out user hitting the entry URL sees OpenWind's own `/login` page first (same as the
default flow) — clicking Sign In from there proceeds to Zitadel's login screen, not an error.
Corrected after live testing (spec §B B3): the redirect to Zitadel is NOT auto-triggered on
mount — that skipped the OpenWind screen entirely with no visible page in between, which wasn't
the intended UX. The user always sees and clicks this page's existing button.
✓ After successful login, the create-ticket page for the correct workflow is shown, with
`title`/`remark` fields pre-populated from the URL's query params
✓ Already-logged-in user who clicks Sign In on the entry URL's `/login` page still calls
`signinRedirect` (no route guard intercepts `/login` pre-auth) without `prompt: "login"` — the
IdP silently reuses the existing session and returns through `/auth/callback` straight to the
pre-filled create page, with no visible Zitadel login form in between

R2: The existing default login flow (no query params) is unaffected.
✓ `GET {adminUiUrl}/login` with no query params still logs in and redirects to `/dashboard`
exactly as today

R3: The user must explicitly submit the ticket themselves — nothing auto-creates on their behalf.
✓ Landing on the pre-filled form does not itself call `POST /entities` (or equivalent) — the
Create button still requires an explicit click
✓ Test asserts no create-API call fires between mount and the first user-initiated submit, with
prefill data present (locks this in as a regression guard, not just "true because unwritten")

R4: No redirect back to the 3rd party occurs at any point in this flow.
✓ Neither `login.tsx` nor `callback.tsx` nor `record-create.tsx` reads or stores a `returnTo`/
`redirect_uri` value sourced from this handoff's query params
✓ Grep for a 3rd-party-controlled redirect target anywhere in this feature's diff returns nothing
✓ `/security-review` run specifically checks this feature's diff for any code path that reads a
URL/query param and passes it to `navigate()`/`window.location` as a redirect target — not just
relying on the feature's absence to prove the invariant

R5: A malformed or unresolvable `workflowId`/`entityTypeId` in the entry URL degrades gracefully,
never as an unhandled crash.
✓ Nonexistent `entityTypeId` (well-formed UUID, no matching row) → falls back to the default
post-login destination (`/dashboard`), same as if no prefill data had been sent at all
✓ Malformed `entityTypeId`/`workflowId` (not a UUID at all) → same graceful fallback to
`/dashboard`, not a thrown error or blank screen
✓ `workflowId` that doesn't belong to the resolved `entityTypeId` → create page loads with no
workflow preselected (existing `record-create.tsx` behavior when `preselect` doesn't match)

R6: The OWTesterUI test harness can exercise this flow without touching its existing in-app
create/comment flows.
✓ A new "Create Here" affordance next to the existing Create Ticket flow opens
`{adminUiUrl}/login?workflowId=...&entityTypeId=...&title=...&remark=...` in a new tab
✓ Existing guided create/comment flows in OWTesterUI are unchanged (same files, same behavior)

R7 (added 2026-09-02, docs/specs/third-party-api-origin-tagging.md R2): Creation via this flow is
rejected outright — no ticket row is ever created — if `appClientId` is missing, malformed, or
doesn't resolve to a real, active, non-revoked `api_keys` row.
✓ Entry URL with no `appClientId` → create page loads (if `workflowId`/`entityTypeId` are
otherwise valid) but the Create button is disabled/submission is rejected server-side with a
clear error — same graceful-degradation posture as R5, not a crash, but never a silent
untagged-ticket fallback either
✓ Entry URL with a well-formed but unregistered/revoked `appClientId` → same rejection
✓ Valid `appClientId` → ticket is created and tagged per the origin-tagging spec's R2

phase gate: all unit tests pass (T5, T6, T7) AND the T8 security-review pass is clean before
Phase 2 (OWTesterUI + docs). Phase 2 gate: manual OWTesterUI walkthrough confirms the link works
end-to-end (logged-out AND already-logged-in cases) against a real running stack.

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                   | root cause                                                                                                                                                                                                                                                                                                                                                                                                              | promoted to §V?                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | (pre-empted, not a real bug) — confirmed `remark` is NOT an existing standardized field name anywhere in the codebase today (grepped, zero hits)              | User's stated plan is that title+remark become default/mandatory fields going forward, but this isn't shipped yet                                                                                                                                                                                                                                                                                                       | No — `prefillFields` is deliberately a generic `Record<string,string>` keyed by actual field `name`, not hardcoded to `title`/`remark`, specifically so this doesn't silently no-op once real field names are confirmed                                                |
| B2  | Manual Phase 3 walkthrough via OWTesterUI: clicking "Create Here" opened a new tab that just hung (no error, no page)                                         | `OWTesterUI`'s standalone Docker Compose project defaulted the handoff base URL to `host.docker.internal:3001` — that hostname only resolves for a process running INSIDE a container (which is why it's correct for OWTesterUI's own server-side `fetch()` proxy calls); the actual browser tab opened via `window.open()` runs on the host OS directly and can't resolve it at all, so the tab hung on DNS resolution | Yes — added as an explicit invariant below: any URL a browser will navigate to (not a server-to-server call) must use a browser-resolvable host, never a container-internal DNS alias                                                                                  |
| B3  | Manual Phase 3 walkthrough, after B2's fix: the tab redirected straight to `owzitadel.rokkalabs.com`'s hosted login page with no OpenWind screen shown at all | `login.tsx`'s original implementation auto-triggered `signinRedirect` in a `useEffect` on mount whenever handoff params were present, to save the user a click. That immediately navigates the browser away to the IdP -- there is no "reuse session silently, land on prefilled page" moment visible for a logged-out user, only an unexplained jump straight to Zitadel with zero OpenWind branding in between        | Yes -- promoted to R1: the handoff redirect must always be user-initiated (a click on `/login`'s existing button), matching the default flow's UX exactly; only the resulting `signinRedirect` CALL differs (no `prompt: "login"`/`removeUser()` for the handoff path) |

---

_spec is source of truth — update as decisions are made_
