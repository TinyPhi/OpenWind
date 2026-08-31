# Implementation Plan: Hosted Ticket-Create Handoff

**Spec:** docs/specs/hosted-ticket-create-handoff.md
**Generated:** 2026-08-31
**Status:** code complete, pending manual Phase 3 walkthrough gate

---

## Phase 1 — Core Mechanism

**Goal:** a 3rd party's entry URL (`/login?workflowId=...&entityTypeId=...&title=...&remark=...`)
carries prefill data through the full Zitadel login round-trip and lands the user on a pre-filled
create-ticket page, for both logged-out and already-logged-in callers, without disturbing the
existing default login flow.
**Gate:** all unit tests pass (T5, T6, T7) → then Phase 2

| task | task                                                                                                                                                                                                                                               | requirement | status |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1   | `login.tsx`: read `workflowId`/`entityTypeId`/`title`/`remark` from its own query string; when present, call `signinRedirect({ state: {...} })` WITHOUT `prompt: "login"` (§I resolution)                                                          | R1          | done   |
| T2   | `callback.tsx`: capture `signinCallback()`'s resolved user (currently discarded); branch on `user.state.workflowId` instead of the unconditional `navigate("/dashboard")`                                                                          | R1, R2      | done   |
| T3   | `callback.tsx`: resolve `entityTypeId` -> `typeSlug` via a direct `fetchWithAuth(`${API_URL}/entity-types/${entityTypeId}`)` call (NOT `EntityTypeProvider`, which doesn't wrap this route); failure/404 falls through to `navigate("/dashboard")` | R5          | done   |
| T4   | `record-create.tsx`: extend `routeState` type with `prefillFields?: Record<string, string>`; seed `fieldValues` from it once the workflow's field schema (`fields`) has loaded, keyed by field `name`                                              | R1, R3      | done   |
| T5   | Unit test (`login.test.tsx`): default login (no query params) still calls `signinRedirect({ prompt: "login" })` unchanged; with query params present, calls it without `prompt` and with the correct `state`                                       | R2          | done   |
| T6   | Unit test (`callback.test.tsx`): prefill flow navigates to the correct `/records/:slug/new` with the right `state`; nonexistent AND malformed (non-UUID) `entityTypeId`/`workflowId` both fall back to `/dashboard`, no thrown error               | R5          | done   |
| T7   | Unit test (`record-create.test.tsx`): with `prefillFields` present, `fieldValues` is seeded correctly and no create-API call fires before an explicit user submit (mount != submit)                                                                | R3          | done   |

---

## Phase 2 — Verification & Security

**Goal:** confirm the no-redirect-back invariant holds by construction, not by accident, before
this ships anywhere near a 3rd party.
**Gate:** T8 security-review pass is clean → then Phase 3

| task | task                                                                                                                                                                                                                                                                                                                                                                                                              | requirement | status |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T8   | `/security-review` pass scoped to this feature's diff (`login.tsx`, `callback.tsx`, `record-create.tsx`): confirm no code path reads a URL/query/`state` value and passes it to `navigate()`/`window.location` as a redirect target; confirm `prefillFields` values are never rendered via `dangerouslySetInnerHTML` or similar (XSS surface, even though React's default JSX escaping should already cover this) | R4          | done   |

---

## Phase 3 — Consumer Integration

**Goal:** the flow is actually usable by a real 3rd-party integrator and testable end-to-end.
**Gate:** manual OWTesterUI walkthrough confirms the link works end-to-end (logged-out AND
already-logged-in cases) against a real running stack — §R acceptance criteria met

| task | task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | requirement | status |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T9   | OWTesterUI: add a "Create Here" button next to the existing Create Ticket flow, opening `{workflowUrl}/login?workflowId=...&entityTypeId=...&title=...&remark=...` in a new tab — existing guided create/comment flows untouched. `workflowUrl` (server var `WORKFLOW_URL`, default `http://localhost:3001`) is a DISTINCT config value from the existing `targetBaseUrl`/`TARGET_BASE_URL` (default `http://host.docker.internal:3001`) — see spec B2/§V: one is a browser-facing URL (`window.open`), the other a server-to-server `fetch()` target, and conflating them silently hangs the browser tab | R6          | done   |
| T10  | Update `docs/third-party-api-design.md` and the partner-facing `third-party-api-reference.md` with this handoff pattern as a documented alternative to the full API-driven create flow                                                                                                                                                                                                                                                                                                                                                                                                                    | R6          | done   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/hosted-ticket-create-handoff.md and
docs/specs/hosted-ticket-create-handoff-tasks.md.

Implement Phase 1 tasks only (T1-T7).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
