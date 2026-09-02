# Implementation Plan: Third-Party API Origin Tagging

**Spec:** docs/specs/third-party-api-origin-tagging.md
**Generated:** 2026-09-02
**Status:** not started

---

## Phase 1 — Data Model

**Goal:** Persist a stable, rotation/rename-proof origin identity on every ticket, sub-ticket, and comment, and close the handoff flow's missing-identity gap at the URL-contract level.
**Gate:** migration applied + isolation tests for the new columns/constraint pass → then Phase 2

| task                                                                                                                                                                                                                                                                                                                                                                                               | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Confirm `api_keys.oidcClientId` as the stable per-application anchor (verified in `rotate.ts` — carried forward on every rotation); no code change, decision recorded in spec §C                                                                                                                                                                                                               | R7          | done   |
| T2: Migration 0090 — added `origin_mechanism` (`api`\|`handoff`\|nullable), `origin_oidc_client_id` (nullable, no FK — see migration's own comment), `origin_performer_user_id` (nullable) to `entity_instances` and `workflow_events` (comments are workflow_events rows, not a separate table — corrected from this task's original wording). All-or-nothing DB CHECK constraint on both tables. | R1–R5, §V   | done   |
| T3: Extended the hosted handoff URL contract (`docs/specs/hosted-ticket-create-handoff.md`) with a required `appClientId` param; updated that spec (new R7, new §V invariant) + `docs/third-party-api-design.md`'s partner-facing description                                                                                                                                                      | R2, §V      | done   |
| T4: Isolation test (`apps/api/tests/isolation/origin-tagging-columns.isolation.test.ts`) — proves the DB-level all-or-nothing CHECK constraint on both tables, 7/7 passing against real Postgres                                                                                                                                                                                                   | §V          | done   |

---

## Phase 2 — API Surface

**Goal:** Every write path that can produce third-party-originated content persists origin correctly; every read path needed for tagging exposes it (app name resolved live via `oidcClientId`, never frozen).
**Gate:** integration tests pass + Phase 1 gate still green → then Phase 3

| task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T5: `apps/api/src/routes/third-party/tickets.ts` create-ticket path (top-level + sub-ticket via `children.ts`, same `resolveOriginOidcClientId` helper) persists `origin_mechanism='api'` + `oidcClientId` + acting-person id on every write. Fails closed (401) if the authenticating key's `oidcClientId` can't be resolved.                                                                                                                                                                                                                                                                                              | R1, R4      | done   |
| T6: Same pattern applied to `comments.ts`'s comment-create path — persists identical origin fields per comment, on the dedicated `workflow_events` columns (not the pre-existing `metadata` jsonb, which stayed for other actor fields)                                                                                                                                                                                                                                                                                                                                                                                     | R3          | done   |
| T7: `apps/api/src/routes/entities/create.ts` (the general human-UI create route the handoff flow actually submits through) gained an optional `appClientId` field; when present it's validated against a real, active, non-revoked `api_keys` row **before** creation, and persists `origin_mechanism='handoff'` + validated `oidcClientId` + the real logged-in user's id. `login.tsx`/`callback.tsx`/`record-create.tsx` thread `appClientId` through the full OAuth state round-trip — required alongside `workflowId`/`entityTypeId` (missing it = same graceful fallback as a bad workflowId, never a partial handoff) | R2          | done   |
| T8: Reject path for T7 — invalid/unregistered/revoked app identifier returns 422, no entity row is created (proven by isolation test, real Postgres)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | R2, §V      | done   |
| T9: New `apps/api/src/lib/resolve-origin-display.ts` (single-row + batch variants) resolves the live `applicationName` for `entities/get.ts` (detail), `entities/list.ts` (records list, batched), and `entities/list-workflow-events.ts` (comments + activity timeline, batched) — prefers the currently-active (non-revoked) `api_keys` row sharing the origin's client id, falls back to most-recent if the whole lineage is revoked. `WorkflowEvent` type + `getWorkflowEventLog`/`executeTransition` extended to carry the raw origin columns through from `workflow-engine`.                                          | R1–R5, R7   | done   |
| T10: Regression test — direct-API creation missing/invalid acting-person identity is still rejected. Confirmed already covered by `requireActingPerson()`'s own dedicated test suite (unaffected by this feature's changes, per that middleware's own docstring) — no new test needed                                                                                                                                                                                                                                                                                                                                       | R6          | done   |

---

## Phase 3 — Consumer-Facing UI

**Goal:** The tag renders correctly, in the agreed format, on every surface a human sees ticket/comment content.
**Gate:** §R acceptance criteria met → then Phase 4

| task                                                                                                                                                                                                                      | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T11: Shared tag-rendering component — takes `origin` (mechanism + resolved app name + performer username), renders `External · [App] · [Person]` / `Redirected · [App] · [Person]`, renders nothing when `origin` is null | R1–R5       | todo   |
| T12: Records-list badge using T11's component                                                                                                                                                                             | R1, R2, R4  | todo   |
| T13: Ticket-detail page tag using T11's component                                                                                                                                                                         | R1, R2, R4  | todo   |
| T14: Comment-thread per-comment tag using T11's component                                                                                                                                                                 | R3          | todo   |
| T15: Activity/history timeline entry tag using T11's component                                                                                                                                                            | R5          | todo   |
| T16: Sub-ticket isolation test — a sub-ticket created via API shows its own tag independent of the parent's tag state (confirms T12/T13 correctly key off the sub-ticket's own origin row, not the parent's)              | R4          | todo   |

---

## Phase 4 — Enforcement, Rotation Safety, and Full Regression

**Goal:** Every §V invariant holds under adversarial/edge conditions, not just the happy path.
**Gate:** all unit + isolation tests pass, full §R acceptance criteria verified end-to-end

| task                                                                                                                                                                                                                                                                                                                                                                                      | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T17: Missing app-identifier param is rejected before it ever reaches the backend — covered by `login.test.tsx`/`callback.test.tsx`'s new tests proving the handoff flow falls back to normal login / `/dashboard` when `appClientId` is absent, same graceful-degradation posture as a bad `workflowId`                                                                                   | R2          | done   |
| T18: Isolation test (`apps/api/tests/isolation/entity-create-handoff-origin-tagging.isolation.test.ts`) — handoff creation with an unregistered/fabricated app-identifier value is rejected (422, no row created)                                                                                                                                                                         | R2          | done   |
| T19: Same file — handoff creation with a revoked key's `oidcClientId` is rejected (422)                                                                                                                                                                                                                                                                                                   | R2          | done   |
| T20: Isolation test (`origin-tagging-rotation-rename-resolution.isolation.test.ts`) — rotate a key after a ticket is tagged; confirms the tag still resolves to the same application afterward. Caught and fixed a real bug during this test: the resolution query originally ordered by `createdAt` ascending, returning the OLDEST (often revoked) row's name instead of the active one | R7          | done   |
| T21: Same file — rename an app's `applicationName` after the rotation above; confirms the ticket's tag now displays the new name, not the one frozen at creation time                                                                                                                                                                                                                     | R7          | done   |
| T22: Full end-to-end pass through OWTesterUI (all 4 environment presets) — create a ticket via direct API, via handoff, post a comment, verify all four tag surfaces render correctly against a real deployment                                                                                                                                                                           | R1–R5       | todo   |

phase gate: all unit + integration tests pass before advancing to next phase

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/third-party-api-origin-tagging.md and docs/specs/third-party-api-origin-tagging-tasks.md.

Implement Phase 1 tasks only (T1–T4).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
