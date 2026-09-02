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

| task                                                                                                                                                                                                                                                                                                                                                       | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T5: `apps/api/src/routes/third-party/tickets.ts` create-ticket path persists `origin_mechanism='api'` + `oidcClientId` + acting-person id on every write (top-level and sub-ticket — same code path per spec's "sub-tickets behave identically")                                                                                                           | R1, R4      | todo   |
| T6: Same route's comment-create path persists identical origin fields per comment                                                                                                                                                                                                                                                                          | R3          | todo   |
| T7: Hosted handoff create-path (`apps/admin-ui/src/pages/customer/record-create.tsx` + its backing API call) validates the new required app-identifier param against a real, active, non-revoked `api_keys` row **before** allowing submission; persists `origin_mechanism='handoff'` + validated `oidcClientId` + the logged-in user's real id on success | R2          | todo   |
| T8: Reject path for T7 — missing/invalid/unregistered/revoked app identifier returns a clear error, no ticket row is created                                                                                                                                                                                                                               | R2, §V      | todo   |
| T9: Read endpoints/queries backing ticket list, ticket detail, comment list, and activity/history timeline join `origin_oidc_client_id` → the currently-active `api_keys` row sharing that client id, to resolve the live `applicationName` at read time (never a frozen name)                                                                             | R1–R5, R7   | todo   |
| T10: Regression test — direct-API creation missing/invalid acting-person identity is still rejected (proves pre-existing dual-identity enforcement, no regression from this feature)                                                                                                                                                                       | R6          | todo   |

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

| task                                                                                                                                                                                                            | requirement | status |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T17: Isolation test — handoff creation with a missing app-identifier param is rejected (no ticket row created)                                                                                                  | R2          | todo   |
| T18: Isolation test — handoff creation with an unregistered/fabricated app-identifier value is rejected                                                                                                         | R2          | todo   |
| T19: Isolation test — handoff creation with a revoked key's `oidcClientId` is rejected                                                                                                                          | R2          | todo   |
| T20: Isolation test — rotate a key after a ticket is tagged; confirm the tag still resolves to the same application afterward                                                                                   | R7          | todo   |
| T21: Isolation test — rename an app's `applicationName` after tickets are tagged; confirm those tags now display the new name, not a frozen one                                                                 | R7          | todo   |
| T22: Full end-to-end pass through OWTesterUI (all 4 environment presets) — create a ticket via direct API, via handoff, post a comment, verify all four tag surfaces render correctly against a real deployment | R1–R5       | todo   |

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
