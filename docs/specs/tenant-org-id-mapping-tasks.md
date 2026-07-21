# Implementation Plan: Tenant ↔ Zitadel Org ID Mapping

**Spec:** docs/specs/tenant-org-id-mapping.md
**Generated:** 2026-07-13
**Status:** not started

---

## Phase 1 — Data model

**Goal:** `tenants` can record which Zitadel org it belongs to, without changing any existing column type.
**Gate:** migration applies cleanly, isolation test suite still green → then Phase 2

| task                                                                   | requirement | status |
| ---------------------------------------------------------------------- | ----------- | ------ |
| T1: Migration — add nullable unique `zitadel_org_id text` to `tenants` | R1          | todo   |
| T2: Insert a `tenants` row mapped to the real org (378675861571829762) | R1          | todo   |

---

## Phase 2 — Auth resolution

**Goal:** requests resolve `tenantId` from the real org mapping in production, keep the dev shortcut locally, and fail closed for unmapped orgs.
**Gate:** unit + isolation tests pass + Phase 1 gate still green

| task                                                                                                        | requirement | status |
| ----------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T3: Add org-id → tenant lookup in the auth request path; reject unmapped orgs cleanly                       | R1, R2      | todo   |
| T4: Confirm `DEV_TENANT_ID` fallback path is unchanged for non-production                                   | R3          | todo   |
| T5: Isolation tests — mapped org scopes correctly; unmapped org is rejected, not 500s                       | R1, R2      | todo   |
| T6: Isolation test — a second, newly-inserted org+tenant mapping resolves correctly without any code change | R5          | todo   |

---

## Phase 3 — Production rollout

**Goal:** the real server can safely run `NODE_ENV=production`.
**Gate:** §R acceptance criteria met; manual smoke pass on server

| task                                                                                                                      | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T7: Write server rollout runbook (set NODE_ENV=production, remove DEV_TENANT_ID, restart, smoke-test login/users/records) | R4          | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/tenant-org-id-mapping.md and docs/specs/tenant-org-id-mapping-tasks.md.

Implement Phase 1 tasks only (T1, T2).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
