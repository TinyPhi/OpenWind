# Implementation Plan: Connector Kill Switch

**Spec:** docs/specs/connector-kill-switch.md
**Generated:** 2026-08-18
**Status:** not started

---

## Phase 1 — Data model + control surface

**Goal:** A migration and an admin route that can flip the switch, with an audit trail.
**Gate:** all unit tests pass → then Phase 2

| task                                                                                  | requirement | status |
| ------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Migration `disabled_at`/`disabled_by` on `connector_credentials` + Drizzle schema | R1          | todo   |
| T2: `PATCH /connectors/:connectorId/disabled` route + audit entry                     | R1          | todo   |

---

## Phase 2 — Enforcement at every processing path

**Goal:** All three places that act on a connector installation (inbound gateway, outbound delivery, polling) respect the flag.
**Gate:** integration tests pass + Phase 1 gate still green

| task                                                                                 | requirement | status |
| ------------------------------------------------------------------------------------ | ----------- | ------ |
| T3: Webhook gateway folds disabled into the existing not-found/no-secret branch      | R2          | todo   |
| T4: Outbound worker throws early on disabled, reusing existing retry/dead-letter     | R3          | todo   |
| T5: Poll scheduler excludes disabled from desired set; poll worker skips if disabled | R4          | todo   |

---

## Phase 3 — Tests

**Goal:** Prove tenant-scoping on the new route and every enforcement path's disabled-branch.
**Gate:** §R acceptance criteria met

| task                                                                                                                                                                 | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T6: Isolation tests — `cursor_state`-style extension for `disabled_at`/`disabled_by`, new route isolation test (real Hono handler + real Postgres, cross-tenant 404) | R1          | todo   |
| T7: Unit tests for the route and every enforcement path's disabled branch                                                                                            | R2, R3, R4  | todo   |

---

## Kick-Off Prompt

```
Read docs/specs/connector-kill-switch.md and docs/specs/connector-kill-switch-tasks.md.

Implement Phase 1 tasks only (T1-T2).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
