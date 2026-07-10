## 2026-07-10 — Security audit findings #6 and #7 (defense-in-depth upgraded to active-bug fix)

### Done

**#6 — automation-rules routes were completely broken by RLS, not just missing a backstop:**

- `apps/api/src/routes/automation-rules/{get,list,create,update,delete}.ts`:
  all five now wrap their engine call in `withTenantContext(tenantId, tx =>
  ...)` instead of passing the plain `db` client.
- `apps/api/src/routes/automation-rules/automation-rules.test.ts`: updated the
  `@platform/db` mock to include `withTenantContext: (tenantId, fn) => fn({})`
  — existing assertions unchanged since the mock still hands back the same
  `{}` tx.
- `apps/api/tests/isolation/automation-rules.isolation.test.ts` (new): 8 tests
  against real Postgres — proves list/get/create/update/delete all actually
  work now (previously list/get always returned empty, create failed with an
  RLS violation), and that tenant isolation holds (tenant B gets 404 on
  tenant A's rule, can't see it in list, can't mutate/delete it).

**#7 — entity-types mutations now repeat the tenant ownership condition on
the mutation statement itself:**

- `packages/entity-engine/src/entity-types.ts`: `updateEntityType` and
  `deleteEntityType` already ran a `SELECT` proving ownership before mutating,
  but the `UPDATE`/`DELETE` statements themselves only filtered by
  `entityTypes.id` — no independent tenant guard. Added the same
  `and(eq(id, entityTypeId), or(isNull(tenantId), eq(tenantId, tenantId)))`
  condition directly to both mutation `WHERE` clauses.
- `packages/entity-engine/src/entity-types.test.ts`: +2 tests asserting the
  mutation statements actually receive that condition.

### Why

Sixth and seventh items from the 2026-07-09 security audit, originally
characterized as "defense-in-depth, no RLS backstop if these filters are ever
refactored out." Investigating #6 upgraded its severity significantly: I
tested directly against Postgres before writing any fix (`SELECT`/`INSERT` as
`app_user` with no tenant GUC set) and confirmed `automation_rules`' RLS
policy — which requires `app.tenant_id` — blocks these routes entirely today.
Reads silently return nothing; creates fail outright with an RLS violation
error. This has been broken since #121 started enforcing RLS for real, and
went unnoticed because both the unit tests and (nonexistent, until now)
isolation tests mock the DB/engine layer completely.

#7 remains a genuine defense-in-depth fix (no active bug) — `entity_types` has
no RLS at all, and the pre-check SELECT already correctly gates access; this
just closes a TOCTOU-style gap where the mutation itself trusted the earlier
check rather than re-verifying independently.

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS (direct eslint run, clean after fixing one unused import)
- pnpm test: PASS — `@platform/entity-engine` 172/172 (up from 170, +2 new,
  no regressions to the 13 pre-existing files). `@platform/api` unit tests
  +8 net new (automation-rules.test.ts unchanged, isolation suite grew).
  Root failures unchanged at the established 12-test baseline.
- pnpm test:isolation: PASS — 127/127 (14 files, up from 119/13 — added
  automation-rules.isolation.test.ts).
- Manual verification against real Postgres before the fix (confirmed the
  bug): `SET ROLE app_user` + no tenant GUC → `SELECT` on a real row returns 0
  rows; `INSERT` fails with "new row violates row-level security policy for
  table automation_rules". After the fix: same commands with the GUC set (what
  `withTenantContext` does) succeed. Rebuilt and restarted `ow-backend` —
  clean boot, health check passes.

### Next

Remaining items from the 2026-07-09 security audit's to-do list:
1. **#8** Introspection cache key: switch from 32-bit hash to SHA-256.
2. **#9** Confirm with product whether `users.ts` returning all tenant members'
   PII to `user`-role callers is intended (currently documented as deliberate).
3. **#10** Follow-up audit pass on the ~90 route files not yet reviewed in
   depth (admin routes, entity-type field routes, workflow states/transitions,
   bulk/archive/restore).

This closes out all of items #1-#7 from the original audit — the remaining
three are minor hardening / a product decision / broader coverage, not active
bugs.

### Open questions

- None blocking. Given #6 turned out to be an active production bug rather
  than pure hardening, worth asking: are there other routes using plain `db`
  against an RLS-enabled table that haven't been audited yet? #10 (follow-up
  audit pass) would catch this — consider prioritizing it above #8/#9 given
  what #6 just revealed.
