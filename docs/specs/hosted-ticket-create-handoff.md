# Hosted Ticket-Create Handoff

> 3rd party opens a new tab to OpenWind's own login+create page w/ workflow+prefill data; user logs
> in (real OpenWind acct) if needed, lands on a pre-filled create-ticket form, creates it themselves.

status: draft
created: 2026-08-31
updated: 2026-08-31

---

## §G Goal

3rd party integration can send its end user (who has a real OpenWind login) straight to a
pre-filled ticket-creation screen w/ one click/link — no re-typing workflow/title/remark, full
native upload UX, no new API surface, no redirect-back to the 3rd party.

## §C Constraints

| constraint     | value                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack          | apps/admin-ui (React, react-router-dom, oidc-client-ts via `userManager`)                                                                                                                      |
| auth           | REAL OpenWind login required (Zitadel, admin-ui's own flow) — explicit product decision, NOT the ADR-012 acting-person/dual-identity model. No auto-login, no SSO-passthrough.                 |
| data transport | `state` param on `userManager.signinRedirect()` (oidc-client-ts) — round-trips through the full OAuth redirect chain automatically. No sessionStorage, no server-side cache.                   |
| out of scope   | Any redirect BACK to the 3rd party after creation (deliberate — avoids open-redirect surface entirely). Any new public API route. Any signed/tamper-proof token scheme (unnecessary — see §V). |
| out of scope   | Auto-submitting the ticket without the user reviewing/clicking Create themselves.                                                                                                              |
| existing code  | `apps/admin-ui/src/pages/login.tsx`, `apps/admin-ui/src/pages/callback.tsx`, `apps/admin-ui/src/pages/customer/record-create.tsx` (route `/records/:typeSlug/new`)                             |

## §I Interfaces

**Entry URL** (opened by the 3rd party in a new tab):

```
{adminUiUrl}/login?workflowId={uuid}&entityTypeId={uuid}&title={text}&remark={text}
```

`workflowId`/`entityTypeId` come from the 3rd party's own prior `GET /workflows` call (already
returns both — see `docs/third-party-api-design.md`). `title`/`remark` are freeform, optional.

**`state` shape** threaded through `signinRedirect`/`signinCallback`:

```ts
{ workflowId?: string; entityTypeId?: string; prefillFields?: Record<string, string> }
```

**Post-login navigation** (`callback.tsx`, replacing the current unconditional
`navigate("/dashboard")`):

- no `state.workflowId` → unchanged: `navigate("/dashboard")`
- `state.workflowId` present → resolve `entityTypeId` → slug (via the same entity-types lookup
  `record-create.tsx` already uses) → `navigate('/records/${slug}/new', { state: { workflowId, entityTypeId, prefillFields } })`

**`record-create.tsx` addition**: extend its existing `routeState` type with `prefillFields?:
Record<string, string>`; seed `fieldValues` from it once `fields` (the workflow's schema) has
loaded, keyed by field `name` — same union already used for `workflowId` preselect.

## §R Requirements

R1: A 3rd party can open a link that, after the user logs in (or immediately, if already logged
in), lands them on that workflow's create-ticket form with the given `title`/`remark` values
already filled in.
✓ Logged-out user hitting the entry URL sees the normal Zitadel login screen, not an error
✓ After successful login, the create-ticket page for the correct workflow is shown, with
`title`/`remark` fields pre-populated from the URL's query params
✓ Already-logged-in user hitting the entry URL skips the login screen (existing session reused)
and still lands on the pre-filled create page

R2: The existing default login flow (no query params) is unaffected.
✓ `GET {adminUiUrl}/login` with no query params still logs in and redirects to `/dashboard`
exactly as today

R3: The user must explicitly submit the ticket themselves — nothing auto-creates on their behalf.
✓ Landing on the pre-filled form does not itself call `POST /entities` (or equivalent) — the
Create button still requires an explicit click

R4: No redirect back to the 3rd party occurs at any point in this flow.
✓ Neither `login.tsx` nor `callback.tsx` nor `record-create.tsx` reads or stores a `returnTo`/
`redirect_uri` value sourced from this handoff's query params
✓ Grep for a 3rd-party-controlled redirect target anywhere in this feature's diff returns nothing

R5: A malformed or unresolvable `workflowId`/`entityTypeId` in the entry URL degrades gracefully,
never as an unhandled crash.
✓ Nonexistent `entityTypeId` → falls back to the default post-login destination (`/dashboard`),
same as if no prefill data had been sent at all
✓ `workflowId` that doesn't belong to the resolved `entityTypeId` → create page loads with no
workflow preselected (existing `record-create.tsx` behavior when `preselect` doesn't match)

R6: The OWTesterUI test harness can exercise this flow without touching its existing in-app
create/comment flows.
✓ A new "Create Here" affordance next to the existing Create Ticket flow opens
`{adminUiUrl}/login?workflowId=...&entityTypeId=...&title=...&remark=...` in a new tab
✓ Existing guided create/comment flows in OWTesterUI are unchanged (same files, same behavior)

## §V Invariants

- This flow NEVER redirects the browser to a URL sourced from 3rd-party-controlled input (no
  open-redirect surface) — `returnTo`/callback-style params from an external source are never
  read by this feature, by design (R4).
- Prefill data (`title`/`remark`) is always presented to the user for review before creation —
  never auto-submitted. Because the user must be authenticated in their own OpenWind session AND
  must explicitly click Create, this is UX convenience only, never a privilege-escalation path —
  no signed token or tamper-proofing is needed for this reason specifically (an attacker-crafted
  link can only pre-fill misleading TEXT the real logged-in user still chooses whether to submit).

## §T Tasks

| id  | task                                                                                                                                                                                                                                              | phase | status | depends  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | `login.tsx`: read `workflowId`/`entityTypeId`/`title`/`remark` from its own query string; pass as `state` into `signinRedirect`                                                                                                                   | 1     | todo   | —        |
| T2  | `callback.tsx`: capture `signinCallback()`'s resolved user (currently discarded); branch on `user.state.workflowId`                                                                                                                               | 1     | todo   | —        |
| T3  | Resolve `entityTypeId` → `typeSlug` in `callback.tsx` for the `/records/:typeSlug/new` navigate target — **open question**: confirm the lookup source (entity-types context/hook vs. a fresh fetch) is available at that point in the render tree | 1     | todo   | T2       |
| T4  | `record-create.tsx`: extend `routeState` type + seed `fieldValues` from `prefillFields`, keyed by field `name`, once the workflow's field schema has loaded                                                                                       | 1     | todo   | T1,T2    |
| T5  | Isolation/unit test: default login (no query params) still lands on `/dashboard`, unaffected (R2)                                                                                                                                                 | 1     | todo   | T1,T2    |
| T6  | Unit test: prefill flow lands on correct create page w/ fields populated; nonexistent entityTypeId/workflowId degrade to R5's fallback, not a crash                                                                                               | 1     | todo   | T2,T3,T4 |
| T7  | OWTesterUI: "Create Here" button opening the entry URL in a new tab, alongside (not replacing) the existing create flow                                                                                                                           | 2     | todo   | T1–T4    |
| T8  | Update `docs/third-party-api-design.md` / partner reference doc with this handoff pattern as a documented alternative to the full API-driven create flow                                                                                          | 2     | todo   | T1–T7    |

phase gate: all unit tests pass (T5, T6) before Phase 2 (OWTesterUI + docs)

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                      | root cause                                                                                                        | promoted to §V?                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | (pre-empted, not a real bug) — confirmed `remark` is NOT an existing standardized field name anywhere in the codebase today (grepped, zero hits) | User's stated plan is that title+remark become default/mandatory fields going forward, but this isn't shipped yet | No — `prefillFields` is deliberately a generic `Record<string,string>` keyed by actual field `name`, not hardcoded to `title`/`remark`, specifically so this doesn't silently no-op once real field names are confirmed |

---

_spec is source of truth — update as decisions are made_
