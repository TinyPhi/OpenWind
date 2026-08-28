# Implementation Plan: Third-Party API — Workflow Field Schema Endpoint

**Spec:** docs/specs/third-party-api-workflow-fields-schema.md
**Generated:** 2026-08-28
**Status:** not started

---

## Phase 1 — Core Endpoint

**Goal:** `GET /workflows/:workflowId/fields` exists, is correctly authed/rate-limited, returns
the right shape, and is proven not to regress anything existing.
**Gate:** all unit + isolation tests pass → then Phase 2

| task                                                                                                                                                                                                                                             | requirement   | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------ |
| T1: Add `GET /workflows/:workflowId/fields` route in `apps/api/src/routes/third-party/` — resolve workflow → entityTypeId, reuse entity-engine's existing global+tenant-specific field lookup verbatim (no new/narrower query)                   | R1, R6        | todo   |
| T2: Wire dual-identity auth + `entity:ticket:read` scope check + standard rate-limit middleware, identical pattern to `GET /workflows`                                                                                                           | R4, R7        | todo   |
| T3: Shape the response per §I — field name/label/type/required/sensitivity/config, `isSystem` included, ordered by `sortOrder`                                                                                                                   | R1, R2, R3    | todo   |
| T4: Isolation tests — happy path (incl. a global-only field + sort-order assertion), zero-fields workflow, cross-tenant 404, missing-scope 403, unauth 401, rate-limit headers present, field-name wire-compatibility check against a live `422` | R1–R4, R6, R7 | todo   |
| T5: Regression check — existing `GET /workflows` and `POST /tickets` isolation/unit suites still pass unmodified                                                                                                                                 | R5            | todo   |

---

## Phase 2 — Docs & Consumer Follow-Up

**Goal:** the new endpoint is documented for partners, and the reference tester UI adopts it.
**Gate:** §R acceptance criteria met (Phase 1 gate still green)

| task                                                                                                                                                                               | requirement | status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T6: Update `docs/third-party-api-design.md` and the partner-facing API reference doc with the new endpoint                                                                         | R1–R7       | todo   |
| T7 (separate PR, outside this repo's plan-lock — lives in `openWindTest/OWTesterUI`): wire OWTesterUI's Create Ticket panel to call this endpoint instead of the raw-JSON textarea | —           | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/third-party-api-workflow-fields-schema.md and
docs/specs/third-party-api-workflow-fields-schema-tasks.md.

Implement Phase 1 tasks only (T1-T5).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
