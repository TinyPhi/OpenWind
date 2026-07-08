## 2026-07-08 — Post-PR #137 cleanup

### Done

- Fixed two cosmetic residuals flagged in PR #137 review:
  - `docs/reviews/2026-06-29-consulting-review.md` §6 item 12 struck through — finding
    was retracted in §2 (no field type discrepancy exists); open action item was misleading.
  - `docs/sup-docs/week-log.md` 2026-07-08 entry corrected — ADR-004 is now second in the
    CLAUDE.md reference list (not "first"), description uses the softened wording.
- `docs/sup-docs/roadmap-tracker.md` last-updated line updated to include PR #137.

### Verification

- pnpm typecheck: N/A — docs-only
- pnpm lint: N/A — docs-only
- pnpm test: N/A — docs-only
- pnpm test:isolation: N/A — docs-only

### Next

1. #126 — emit `entity.created` / `entity.assigned` to the outbox (core function, currently dead automations)
2. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
3. Remaining hardening items #120, #123, #124, #125, #128, #129

### Open questions

- None blocking.

---

## 2026-07-07 — Hardening #121 / #122: RLS role enforcement

### Done

- `packages/db/src/middleware.ts`: `withTenantContext` now issues `SET LOCAL ROLE app_user`
  before setting the `app.tenant_id` GUC, mirroring `withTenantAndUserContext`. Closes #121.
- `packages/db/src/client.ts`: same fix in `executeRawInTenantContext` (used by module seed SQL).
- `packages/db/migrations/0022_app_user_rls_grants.sql`: grants `app_user` the
  `INSERT/UPDATE/DELETE` it was missing on `entity_types`, `workflows`, `workflow_states`,
  `workflow_transitions` (previously SELECT-only), and `UPDATE` on `tenants` — required
  because workflow-state/transition CRUD, module install/uninstall, and module seed SQL all
  route through `withTenantContext`/`executeRawInTenantContext` and would otherwise start
  failing with permission-denied the moment the role switch landed.
- Un-skipped the three cross-tenant RLS assertions (#122): `entity-engine.isolation.test.ts`,
  `workflow-engine.isolation.test.ts`, and `automation-engine.isolation.test.ts` (this last
  one had no assertion at all — wrote a real direct-SELECT-via-RLS test for it, using
  `withTenantContext` + a query with no explicit tenant filter, matching the other two files).
- Updated `.claude/rules/db-conventions.md` and `.claude/rules/security.md` to describe the
  new role-switch behavior instead of the stale "RLS is bypassed" warning.
- Branch: `fix/PLAT-121-rls-role`. Plan-lock approved by human before any source edit.

### /code-review + /security-review findings (fixed before shipping)

Security review: no findings (traced every call site touching newly-granted tables; all
tenant-scoped writes are JWT-derived and gated by pre-existing ownership checks).

Correctness review surfaced two real bugs, both fixed:

- **`apps/worker/src/tenant-purge.ts:154`** deletes from `dead_letter_events` inside
  `withTenantContext`, but `app_user` only had SELECT+INSERT on that table (migration 0019)
  — the role switch would have broken tenant purge/GDPR deletion with permission-denied for
  any tenant with a dead-lettered job. Added `GRANT DELETE ON dead_letter_events TO app_user`
  to migration 0022.
- **`automation-engine.isolation.test.ts`**'s un-skipped RLS test never seeded a Tenant B
  `automation_executions` row, so it passed vacuously regardless of whether RLS worked.
  Added a `beforeAll` that creates a real Tenant B execution via `executeAutomationRules`,
  plus a sanity-check test proving the row exists (via superuser query) before the RLS test
  proves it's invisible from Tenant A's context.

Also fixed two lower-severity findings: `security.md` pointed only to migration 0019 for
`app_user`'s grants (now also references 0022), and 0022's DOWN MIGRATION block was buried
after 20 lines of rationale instead of near the top like every sibling migration.

Declined one cleanup suggestion: dedup the `SET LOCAL ROLE app_user` line across 3 call
sites into a shared helper — CLAUDE.md's code-style guidance favors 3 similar 2-line blocks
over a premature abstraction, and it matches the file's pre-existing pattern.

Re-ran the full exit condition after fixes: typecheck/lint/test/test:isolation all still
green (see Verification below, numbers reflect the post-fix state).

### New finding — filed as [#136](../../issues/136), not fixed in this PR

`entity_types` and `workflows` have a nullable `tenant_id` but **no RLS policy at all**
(`NULL` tenant_id = system/template rows visible to every tenant); `workflow_states` /
`workflow_transitions` have no `tenant_id` column at all — isolation there depends entirely
on the explicit ownership checks in `packages/workflow-engine` (`assertWorkflowOwned`,
`visibleTo`). This was already true before this PR (RLS was bypassed everywhere via the
superuser connection) — the grant migration does not change or worsen it, since GRANTs are
table-level, not row-level. But it means these four tables have zero second line of defense.
Needs a design decision (schema change) before Phase 3 — tracked in #136.

### Human PR review round (PR #135, reviewed by @PrabhuVijit) — all addressed

PR approved with 2 medium + 3 low non-blocking items; user asked to fix all of them in this
PR rather than defer, since none required large changes:

- **SEC-1** (medium): `GRANT UPDATE ON tenants` was table-wide; column-scoped to
  `GRANT UPDATE (config, updated_at) ON tenants TO app_user` — the only columns the
  module-install/uninstall call site writes. Amended migration 0022 directly (pre-merge,
  never applied to a real environment).
- **TEST-1** (medium): fixing the vacuous-test bug (see above) had removed the only
  assertion that Tenant A's `executeAutomationRules` run doesn't write execution rows
  attributed to Tenant B's rule (the engine-level `WHERE tenant_id` guard, distinct from
  the RLS layer). Restored it as a new test scoped by `ruleId = ruleIdB AND tenantId =
  TENANT_A`.
- **DOCS-1** (low): fixed a markdown line-wrap in `security.md` where prettier had broken
  a sentence mid-backtick-phrase (`` `SET LOCAL ROLE\napp_user` `` at column 0).
- **SUGG-1** (low): filed #136 for the no-RLS tracking issue instead of leaving it as a
  PROGRESS.md note.
- **SUGG-2** (low): added a comment in `executeRawInTenantContext` pointing future module-
  seed authors at the 0022 grant pattern if they hit `permission denied for table X`.

### Verification (CI-equivalent local run — see note below)

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: PASS (321/321 — up from 320: the automation-engine isolation suite grew from
  8 real + 1 no-op skip → 9 real assertions after the initial fix, then +1 more restoring
  the engine-layer WHERE test from the PR review round)
- pnpm test:isolation: PASS (112/112, all three previously-`.skip`'d RLS assertions run for
  real and pass, plus the restored engine-layer assertion)

**How verification was run:** OrbStack was not running at session start. The repo's own
`docker-compose.yml` `postgres` service couldn't bind port 5432 because a pre-existing,
unrelated container (`platform-postgres-1`, same repo directory but an older compose
project name, still running from a prior session) already held it — left untouched, not
part of this PR. Instead of reusing that dev container (which has broader ambient app_user
grants from `docker/postgres/init/001_setup.sql`'s `ALTER DEFAULT PRIVILEGES`, masking any
CI-only grant gaps), spun up plain `postgres:16-alpine` + `redis:7-alpine` containers on
ports 5433/6379 matching `.github/workflows/ci.yml` exactly (same `platform` superuser,
same `platform_test` DB, no init script) so the grant migration was validated against the
same conditions as the real CI gate. Removed both temp containers after the run.

### Next

Per the consulting review (`docs/reviews/2026-06-29-consulting-review.md`) and the
hardening checklist in CLAUDE.md, in order:

1. #126 — emit `entity.created` / `entity.assigned` to the outbox (core function, currently
   dead automations)
2. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
3. Doc fixes from the review: `roadmap-tracker.md` Phase 2 gate wording, `platform-vision.md`
   Mermaid diagram, ADR-004 added to CLAUDE.md reference list
4. Remaining hardening items #120, #123, #124, #125, #128, #129
5. #136 — design + implement RLS policies for `entity_types`/`workflows`/`workflow_states`/
   `workflow_transitions` (filed during PR #135 review)

### Open questions

- None blocking.
