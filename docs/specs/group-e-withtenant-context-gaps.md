# Group E — withTenantContext gaps in workers and routes

> Fix 4 locations where DB writes/reads run as the superuser role, bypassing
> the `SET LOCAL ROLE app_user` second layer of tenant isolation.

status: draft
created: 2026-07-31
updated: 2026-07-31

---

## §G Goal

Every tenant-scoped DB operation runs inside `withTenantContext` (or
`withTenantAndUserContext`) so RLS is enforced regardless of the connection role.
After this fix: no tenant-scoped read or write in workers or the affected routes
skips the `SET LOCAL ROLE app_user` + GUC setup step.

---

## §C Constraints

| constraint   | value                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| stack        | TypeScript, Drizzle, Hono, BullMQ, `@platform/db`                                        |
| auth         | ADR-001: two layers mandatory — explicit `WHERE tenant_id` + RLS via `withTenantContext` |
| out of scope | `outbox_events` / `dead_letter_events` RLS status (#230/#263 — Group F)                  |
| out of scope | any schema change other than what the fixes require                                      |

**`withTenantContext` contract:** starts its own transaction, executes
`SET LOCAL ROLE app_user` then `set_config('app.tenant_id', …, true)`, then
runs the callback on the resulting `tx`.

**Nesting constraint for `sla-scheduler.ts`:** `withTenantContext` opens a new
`db.transaction()`. `tick()` already runs inside `db.transaction()` (FOR UPDATE
SKIP LOCKED requires the outer transaction). Nesting would use a savepoint, but
`SET LOCAL ROLE` is transaction-scoped, not savepoint-scoped — the role switch
applies to the outer transaction and cannot be undone by savepoint rollback. Fix
must therefore add the two SQL statements (`SET LOCAL ROLE app_user` +
`set_config`) inline within the existing `tx`, not nest a second transaction.

---

## §I Interfaces

Four files changed. No new public API surface.

| file                                                  | issue | problem                                                                                         | fix pattern                                                                                                                  |
| ----------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/src/sla-breacher.ts`                     | #243  | `db.transaction()` in job processor + manual `set_config` without role switch in failed handler | replace both with `withTenantContext`                                                                                        |
| `apps/worker/src/sla-scheduler.ts`                    | #244  | manual `set_config` for dead-letter writes, no `SET LOCAL ROLE`                                 | add `SET LOCAL ROLE app_user` before each `set_config` call within the outer `tx`                                            |
| `apps/api/src/routes/preferences/notifications.ts`    | #254  | `getUserPreferences(db, …)` and `updateUserPreferences(db, …)` use module-level `db`            | wrap each call in `withTenantContext`; `app_user` has `SELECT` + `UPDATE (config, updated_at)` on `tenants` (migration 0022) |
| `apps/api/src/routes/entity-types/get.ts` + `list.ts` | #234  | `getEntityType(db, …)` / `listEntityTypes(db, …)` use module-level `db`                         | wrap each call in `withTenantContext`                                                                                        |

---

## §R Requirements

R1: `sla-breacher.ts` job processor uses `withTenantContext`
✓ Main `db.transaction()` replaced with `withTenantContext(tenantId, async (tx) => …)`
✓ Guard SELECT and outbox INSERT both execute as `app_user`

R2: `sla-breacher.ts` failed-handler dead-letter write uses `withTenantContext`
✓ `db.transaction()` in the `failed` event handler replaced with `withTenantContext`
✓ Manual `set_config` removed; `withTenantContext` sets both role and GUC

R3: `sla-scheduler.ts` dead-letter writes add role switch within the outer transaction
✓ Each per-tenant dead-letter block executes `SET LOCAL ROLE app_user` before `set_config`
✓ Outer `db.transaction()` (FOR UPDATE SKIP LOCKED atomicity) is preserved intact

R4: Notification preference routes use `withTenantContext`
✓ GET handler: `getUserPreferences` called inside `withTenantContext`
✓ PATCH handler: `updateUserPreferences` called inside `withTenantContext`
✓ Both run as `app_user` (SELECT + UPDATE (config) on `tenants` already granted — migration 0022)

R5: Entity-type GET routes use `withTenantContext`
✓ `getEntityType` called inside `withTenantContext` in `get.ts`
✓ `listEntityTypes` called inside `withTenantContext` in `list.ts`

R6: No existing tests broken; new tests added for each fixed path
✓ `sla-breacher.test.ts` — verifies `withTenantContext` is called with the job's tenantId
✓ `sla-scheduler.test.ts` — verifies dead-letter path calls `SET LOCAL ROLE app_user`
✓ Route tests verify `withTenantContext` called with auth `tenantId`

---

## §V Invariants

- Every tenant-scoped DB write runs inside `withTenantContext` or `withTenantAndUserContext` — never bare `db.transaction()` with manual GUC.
- Worker failed-event handlers follow the same two-layer rule as job processors.
- When an existing transaction cannot be replaced (FOR UPDATE SKIP LOCKED), both `SET LOCAL ROLE app_user` and `set_config` must be issued manually within that tx — never just `set_config` alone.

---

## §T Tasks

| id  | task                                                                                             | phase | status | depends |
| --- | ------------------------------------------------------------------------------------------------ | ----- | ------ | ------- |
| T1  | Fix `sla-breacher.ts` — replace `db.transaction()` with `withTenantContext` in job processor     | 1     | todo   | —       |
| T2  | Fix `sla-breacher.ts` — replace manual `set_config` in `failed` handler with `withTenantContext` | 1     | todo   | T1      |
| T3  | Fix `sla-scheduler.ts` — add `SET LOCAL ROLE app_user` before each dead-letter `set_config`      | 1     | todo   | —       |
| T4  | Fix `preferences/notifications.ts` — wrap both handlers in `withTenantContext`                   | 1     | todo   | —       |
| T5  | Fix `entity-types/get.ts` + `list.ts` — wrap engine calls in `withTenantContext`                 | 1     | todo   | —       |
| T6  | Update `sla-breacher.test.ts` to assert `withTenantContext` called                               | 2     | todo   | T1,T2   |
| T7  | Update `sla-scheduler.test.ts` to assert role-switch SQL issued                                  | 2     | todo   | T3      |
| T8  | Add/update route tests for preferences and entity-type handlers                                  | 2     | todo   | T4,T5   |

phase gate: typecheck + lint + unit tests pass before advancing

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |
