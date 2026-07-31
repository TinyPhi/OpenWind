# Implementation Plan: `loadEntityType` Explicit Tenant Filter (#220)

**Spec:** docs/specs/entity-engine-load-entity-type-tenant-filter-220.md
**Generated:** 2026-07-31
**Status:** implemented

---

## Phase 1 — Core Domain Fix

**Goal:** `loadEntityType` gains the same explicit tenant filter `loadEntityFields` already
has; every call site in `engine.ts` passes it a `tenantId` it already has in scope.
**Gate:** `pnpm typecheck` clean (compiler enforces the new required param at all 9 call
sites) + `pnpm test --filter @platform/entity-engine` green → then Phase 2

| task                                                                                                                                                                                                        | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T1: Add `tenantId: string` param to `loadEntityType` (engine.ts:994) + `or(isNull(entityTypes.tenantId), eq(entityTypes.tenantId, tenantId))` filter, mirroring `loadEntityFields` (engine.ts:1016) exactly | R1, R3      | done   |
| T2: Update all 9 call sites (lines 146, 435, 829, 957, 1111, 1363, 1481, 1749, 1897) to pass the `tenantId` already in scope at each                                                                        | R2, R3      | done   |

---

## Phase 2 — Verification

**Goal:** Prove the explicit filter — not RLS — is what blocks the cross-tenant case, and
confirm zero regression on legitimate paths.
**Gate:** §R acceptance criteria met; full exit condition green

| task                                                                                                                                                                                                                                                                                                         | requirement | status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------ |
| T3: New isolation test (`apps/api/tests/isolation/`) — bare `db` (no `withTenantContext`), Tenant A calls `createEntity`/`addEntityField` with Tenant B's private `entityTypeId` → `ENTITY_TYPE_NOT_FOUND`; same test confirms a shared/global (`tenantId IS NULL`) entity type still resolves via bare `db` | R1          | done   |
| T4: Run full exit condition — `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation`                                                                                                                                                                                                              | R2, R3      | done   |

---

## Kick-Off Prompt

Copy this into your Claude Code session to start implementation:

```
Read docs/specs/entity-engine-load-entity-type-tenant-filter-220.md and
docs/specs/entity-engine-load-entity-type-tenant-filter-220-tasks.md.

Implement Phase 1 tasks only (T1, T2).

Rules:
- T2 depends on T1 — signature must change before call sites are updated
- Do not begin Phase 2 (T3, T4) until Phase 1's typecheck/test gate is green
- This is a mechanical, behavior-preserving change for every existing call site — if any
  call site doesn't obviously have a tenantId in scope, stop and ask (per the spec, all 9
  do; this would mean the spec's call-site inventory is stale and needs re-verifying against
  current source first)
- No public API changes — loadEntityType is an unexported internal helper
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
