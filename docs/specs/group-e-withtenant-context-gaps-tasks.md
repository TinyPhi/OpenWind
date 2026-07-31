# Implementation Plan: Group E — withTenantContext gaps

**Spec:** docs/specs/group-e-withtenant-context-gaps.md
**Generated:** 2026-07-31
**Status:** not started

---

## Phase 1 — Code fixes + tests (all four locations)

**Goal:** Every affected file passes bare-`db` usage through `withTenantContext`
(or the inline role-switch equivalent for `sla-scheduler`), with tests proving
the tenant context is established before each DB operation.

**Gate:** `pnpm typecheck && pnpm lint && pnpm test` all green → then Phase 2

| task                                                                                           | requirement | files                                                         | status |
| ---------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------- | ------ |
| T1: Replace `db.transaction()` with `withTenantContext` in `sla-breacher` job processor        | R1          | `apps/worker/src/sla-breacher.ts` + `.test.ts`                | todo   |
| T2: Replace manual `set_config` with `withTenantContext` in `sla-breacher` failed handler      | R2          | `apps/worker/src/sla-breacher.ts` + `.test.ts`                | todo   |
| T3: Add `SET LOCAL ROLE app_user` before each dead-letter `set_config` in `sla-scheduler` tick | R3          | `apps/worker/src/sla-scheduler.ts` + `.test.ts`               | todo   |
| T4: Wrap `getUserPreferences` + `updateUserPreferences` in `withTenantContext`                 | R4          | `apps/api/src/routes/preferences/notifications.ts` + new test | todo   |
| T5: Wrap `getEntityType` + `listEntityTypes` in `withTenantContext`                            | R5          | `apps/api/src/routes/entity-types/get.ts`, `list.ts` + tests  | todo   |

**Acceptance criteria for Phase 1 gate (each task):**

- `withTenantContext` (or role-switch SQL) confirmed called via test assertion
- `db` module-level import no longer passed directly to engine/service functions
- No type errors (`pnpm typecheck` clean)
- No lint errors (`pnpm lint` clean)

---

## Phase 2 — Verify + Ship

**Goal:** Confirm isolation tests still pass, docs marker written, PR opened.

**Gate:** `pnpm test:isolation` green (requires Docker stack) → PR opened

| task                                                                 | requirement | status |
| -------------------------------------------------------------------- | ----------- | ------ |
| T6: Run `pnpm test:isolation` — confirm no RLS regression            | R1–R5       | todo   |
| T7: Update `week-log.md` + `roadmap-tracker.md`                      | —           | todo   |
| T8: Write docs marker (`write-docs-marker.sh --touched`) and open PR | —           | todo   |

---

## Implementation notes

**T1/T2 — `sla-breacher.ts`:**

```
import { withTenantContext } from "@platform/db";

// Job processor (T1):
await withTenantContext(tenantId, async (tx) => {
  // guard SELECT + outbox INSERT — unchanged, just use tx instead of db
});

// Failed handler (T2) — replace the manual db.transaction block:
void withTenantContext(tenantId, async (tx) => {
  await tx.insert(deadLetterEvents).values({ … });
}).catch(…);
```

**T3 — `sla-scheduler.ts`:** Cannot nest `withTenantContext` (outer FOR UPDATE SKIP
LOCKED transaction must remain). Within the existing `tx`, before each per-tenant
`set_config`:

```
await tx.execute(sql`SET LOCAL ROLE app_user`);
await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
```

**T4 — `preferences/notifications.ts`:**

```
import { withTenantContext } from "@platform/db";
// Remove: import { db } from "@platform/db";

// GET:
const prefs = await withTenantContext(tenantId, (tx) =>
  getUserPreferences(tx, tenantId, userId)
);

// PATCH:
const updated = await withTenantContext(tenantId, (tx) =>
  updateUserPreferences(tx, tenantId, userId, input as Partial<NotificationPreferences>)
);
```

**T5 — `entity-types/get.ts` + `list.ts`:**

```
import { withTenantContext } from "@platform/db";
// Remove: import { db } from "@platform/db";

// get.ts:
const entityType = await withTenantContext(tenantId, (tx) =>
  getEntityType(tx, tenantId, id)
);

// list.ts:
const page = await withTenantContext(tenantId, (tx) =>
  listEntityTypes(tx, tenantId, { moduleId, cursor, limit })
);
```

---

## Kick-Off Prompt

```
Read docs/specs/group-e-withtenant-context-gaps.md and
docs/specs/group-e-withtenant-context-gaps-tasks.md.

Create branch fix/PLAT-security-group-e from main, then implement all
Phase 1 tasks (T1–T5). Tests must be written in the same pass as the fix.

Key constraints:
- T3 (sla-scheduler): DO NOT nest withTenantContext inside the outer db.transaction().
  Add SET LOCAL ROLE app_user + set_config inline within the existing tx instead.
- T1/T2 (sla-breacher): the main job processor AND the failed-event handler both need fixing.
- T4 (preferences): app_user already has UPDATE (config, updated_at) on tenants
  (migration 0022) — withTenantContext will work for both GET and PATCH.

After each task: run pnpm typecheck && pnpm lint && pnpm test and confirm green
before moving to the next task. Do not advance to Phase 2 until all five tasks pass.

If you hit anything not covered by the spec, stop and ask — do not assume.
```

---

_Backprop reminder: if any test fails during implementation, run `/spec amend §B`
to log it. If a bug class could recur, promote it to `§V` with `/spec amend §V`._
