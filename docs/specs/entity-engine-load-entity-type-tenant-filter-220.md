# `loadEntityType` Explicit Tenant Filter (#220)

> Give `loadEntityType` the same explicit tenant-scoping `loadEntityFields` already has, so
> `entity-engine` doesn't rely on RLS as its only guard on this one path.

status: implemented
created: 2026-07-31
updated: 2026-07-31

---

## §G Goal

- `loadEntityType` takes a `tenantId` and applies the same
  `or(isNull(tenantId), eq(tenantId, ...))` filter `loadEntityFields` uses — no call site left
  relying on RLS alone for tenant scoping on this read.
- Behavior unchanged for every legitimate call today (own-tenant + shared/global entity types
  still resolve).
- The previously RLS-masked cross-tenant case now also fails via the explicit filter, provable
  with a bare `db` connection (no `withTenantContext`, so RLS is not in play).

## §C Constraints

| constraint   | value                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | `packages/entity-engine/src/engine.ts` only — internal helper + its call sites in the same file                                                                                                    |
| auth         | n/a — tenant scoping, not authn/authz                                                                                                                                                              |
| out of scope | Any change to `loadEntityFields` (already correct), any change to `entityTypes` RLS policy (ADR-007, already accepted), any change to `child-relations.ts` or other packages, `packages/db` schema |
| touches      | `packages/entity-engine/src/engine.ts`, one new isolation test file under `apps/api/tests/isolation/`                                                                                              |
| precedent    | Mirrors `loadEntityFields` (engine.ts:1016) exactly — same filter shape, same nullable-tenant (shared/global type) semantics                                                                       |

## §I Interfaces

`loadEntityType` signature change (internal helper, not exported — no public API break):

```
// before
async function loadEntityType(db: DbOrTx, entityTypeId: string): Promise<EntityType>

// after
async function loadEntityType(db: DbOrTx, entityTypeId: string, tenantId: string): Promise<EntityType>
```

Query gains: `and(eq(entityTypes.id, entityTypeId), or(isNull(entityTypes.tenantId), eq(entityTypes.tenantId, tenantId)))`

9 call sites in `engine.ts` (verified against current source, 2026-07-31):

| line | caller                   | tenantId source                                               | category                                    |
| ---- | ------------------------ | ------------------------------------------------------------- | ------------------------------------------- |
| 146  | `createEntity`           | `input.entityTypeId`, fn param `tenantId` (already has it)    | meaningful — caller-supplied `entityTypeId` |
| 435  | `updateEntity`           | `existing.entityTypeId` (tenant-scoped read already happened) | pass-through                                |
| 829  | (bulk path)              | `row.entityTypeId`, `tenantId` in scope                       | pass-through                                |
| 957  | `addEntityField`         | `entityTypeId` param, fn param `tenantId` (already has it)    | meaningful — caller-supplied `entityTypeId` |
| 1111 | (bulk path)              | `entityTypeId`, `tenantId` in scope                           | pass-through                                |
| 1363 | `updateEntity` (variant) | `existing.entityTypeId`                                       | pass-through                                |
| 1481 | (bulk path)              | `existing.entityTypeId`, `tenantId`                           | pass-through                                |
| 1749 | (bulk path)              | `prior.entityTypeId`, `tenantId`                              | pass-through                                |
| 1897 | (bulk path)              | `existing.entityTypeId`, `tenantId`                           | pass-through                                |

Every call site already has a `tenantId` value in scope (either a function parameter or a
tenant-scoped row already fetched) — no new parameter threading into functions that don't
already take one.

## §R Requirements

R1: `loadEntityType` never returns a row belonging to a different tenant's private entity type
✓ new isolation test: bare `db` (no `withTenantContext`), Tenant A calls `createEntity`/
`addEntityField` with Tenant B's private (non-null `tenantId`) entity type id → throws
`ENTITY_TYPE_NOT_FOUND`, proving the explicit filter — not RLS — blocks it
✓ same test asserts a shared/global entity type (`tenantId IS NULL`) still resolves for any
tenant, via bare `db`

R2: No behavior change for existing legitimate call paths
✓ `pnpm test --filter @platform/entity-engine` — all existing tests green (own-tenant and
shared-type reads still succeed)
✓ `pnpm test:isolation` — all existing isolation tests green (RLS-context paths unaffected)

R3: All 9 call sites updated consistently, no call site left passing only 2 args
✓ `grep -n "loadEntityType(" packages/entity-engine/src/engine.ts` — every call passes 3 args
✓ `pnpm typecheck` — zero errors (compiler enforces the new required param at every call site)

## §V Invariants

- Every tenant-scoped read in `engine.ts` has an explicit `WHERE`/filter tenant guard in
  addition to RLS — no helper relies on RLS as its only layer (per `db-conventions.md` /
  `security.md`). `loadEntityType` joining `loadEntityFields` in this pattern closes the last
  known outlier; any new helper added to this file must follow the same shape.

## §T Tasks

| id  | task                                                                                                                             | phase | status | depends  |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | Add `tenantId` param + `or(isNull, eq)` filter to `loadEntityType` (engine.ts:994)                                               | 1     | done   | —        |
| T2  | Update all 9 call sites to pass `tenantId` (already in scope at each)                                                            | 1     | done   | T1       |
| T3  | New isolation test: bare `db`, cross-tenant `entityTypeId` via `createEntity`/`addEntityField` → 404; shared-type still resolves | 1     | done   | T2       |
| T4  | Run full exit condition (`typecheck`, `lint`, `test`, `test:isolation`)                                                          | 2     | done   | T1,T2,T3 |

phase gate: T1–T3 land as one commit set; T4 all green before opening PR

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                                                                                                                                  | root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | promoted to §V?                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Full `pnpm test:isolation`/`pnpm test` runs during T4 initially showed failures in `ticket-alerts*.isolation.test.ts` (duplicate-key/FK errors), `modules.test.ts`/`quarantine-flow.test.ts`/`upload-flow.test.ts` (Redis `ECONNREFUSED`), and `view-configs.test.ts` (already-tracked #149) | (a) local test DB had pending migrations (`ticket_alerts` table missing) plus dangling rows from earlier interrupted runs in this same session — fixed by running migrations + manual cleanup; (b) Redis has no host port mapping in this repo's `docker-compose.yml` (intentional, see CLAUDE.md maintenance notes) so host-mode `pnpm test` can't reach it — this only affects local host-mode runs, not CI/`docker compose up -d`; (c) #149 is pre-existing, already filed, unrelated to this change | no — (a) was one-off local sandbox drift, not a recurring class; (b)/(c) are already-known environmental/tracked issues, not new invariants for this spec |

---

_spec is source of truth — update as decisions are made_
