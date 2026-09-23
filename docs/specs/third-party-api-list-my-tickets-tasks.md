# Implementation Plan: Third-Party API — List My Tickets

**Spec:** docs/specs/third-party-api-list-my-tickets.md
**Generated:** 2026-08-28
**Status:** not started

---

## Phase 1 — Core Endpoint

**Goal:** `GET /workflows/:workflowId/tickets` exists, correctly scoped/paginated/redacted, with
guaranteed list/get parity, and proven not to regress anything existing.
**Gate:** all unit + isolation tests pass → then Phase 2

| task                                                                                                                                                                                                                                                                                                                       | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Add `GET /workflows/:workflowId/tickets` route — resolve workflow → entityTypeId, resolve workflow-admin status, call `listEntities` with `scopeToUserId` (or unscoped if admin)                                                                                                                                       | R1, R2      | todo   |
| T2: Wire dual-identity auth + `entity:ticket:read` scope + standard rate-limit middleware, identical pattern to sibling routes                                                                                                                                                                                             | R7          | todo   |
| T3: Apply redaction once per page (hoist `entity_fields`/sensitivity-map lookup out of the per-row loop)                                                                                                                                                                                                                   | R4          | todo   |
| T4: Shape the response per §I — `data`/`nextCursor`, `state`/`limit`/`cursor` query params, 422 on invalid `limit`/malformed `cursor`                                                                                                                                                                                      | R3          | todo   |
| T5: List/get-parity post-filter — drop any row whose only access path is an `__accessUsers` grant with a non-standard `level`, without shifting the pagination cursor boundary                                                                                                                                             | R1, R3      | todo   |
| T6: Isolation tests — creator/assignee/ACL-grant visibility, non-related-ticket exclusion, workflow-admin full visibility, list/get parity, pagination (2+ pages, no dupes/gaps, malformed-cursor 422), redaction, tenant isolation, cross-tenant/nonexistent 404, missing-scope 403, invalid auth 401, rate-limit headers | R1–R5, R7   | todo   |
| T7: Regression check — existing `GET /tickets/:id`, `GET /workflows`, `GET /workflows/:id/fields` suites still pass unmodified                                                                                                                                                                                             | R6          | todo   |

---

## Phase 2 — Docs & Consumer Follow-Up

**Goal:** the new endpoint is documented for partners, and the reference tester UI adopts it.
**Gate:** §R acceptance criteria met (Phase 1 gate still green)

| task                                                                                                                                                                      | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T8: Update the partner-facing API reference doc with the new endpoint                                                                                                     | R1–R7       | todo   |
| T9 (separate PR, outside this repo's plan-lock — lives in `openWindTest/OWTesterUI`): wire the comment flow to call this instead of requiring a manually-pasted ticket ID | —           | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/third-party-api-list-my-tickets.md and
docs/specs/third-party-api-list-my-tickets-tasks.md.

Implement Phase 1 tasks only (T1-T7).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
