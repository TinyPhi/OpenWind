## 2026-07-08 — Hardening #126: entity.created / entity.assigned triggers

### Done

- `packages/entity-engine/src/types.ts`: added local `EntityCreatedEvent`/`EntityAssignedEvent`
  interfaces (plain TS, no cross-package import — entity-engine may only depend on `db` per
  CLAUDE.md's dependency rule; automation-engine already depends on entity-engine, so the
  reverse import would be a cycle). Mirrors how `workflow-engine` defines
  `WorkflowTransitionedEvent` locally rather than importing automation-engine's zod schema.
- `packages/entity-engine/src/engine.ts`: `createEntity`, `updateEntity` (both branches),
  `bulkCreateEntities`, and `bulkUpdateEntities` now write `entity.created`/`entity.assigned`
  rows to `outbox_events` in the same transaction. Closes #126.
  - `entity.assigned` fires on any transition to a new non-null assignee — both
    create-with-assignee and reassignment via update (confirmed with the user; the schema's
    non-nullable `assigneeId` can't represent unassignment, so that case doesn't fire).
  - Flagged with a code comment: this is the first path that makes #120's unbounded
    outbox-routed automation recursion actually reachable (entity.created/assigned rules can
    chain into create/update actions). Not fixed here — #120 stays out of scope.
- **Found and fixed an adjacent bug while writing the Prove-It test**:
  `modules/helpdesk/seed/003_automation_rules.sql`'s "auto-set priority" rule — the exact
  example the consulting review cited as "silently does nothing" — used the wrong action
  shape entirely: `{"type": "set-field", "field": ..., "value": ...}` when the executor's
  `case "set_field"` expects `{"type": "set_field", "config": {"field": ..., "value": ...}}`.
  Without this fix, the rule would have kept silently doing nothing after #126 landed, just
  for a different reason. One-line seed SQL data fix, no schema/API change.
- New isolation test `apps/api/tests/isolation/entity-created-trigger.isolation.test.ts` (5
  tests) — Prove-It Pattern: written first, confirmed failing against unfixed `engine.ts`
  (verified via `git stash` on just that file), confirmed passing after the fix. Proves the
  full chain end-to-end: create an entity → real `outbox_events` row written → handed to
  `executeAutomationRules` exactly as the outbox poller would → the helpdesk-style
  `set_field` rule actually applies the field change. Also covers entity.assigned on create
  and on reassignment, and that re-assigning to the same assignee doesn't re-fire.
- Updated `engine.test.ts`/`bulk.test.ts` mocks and call-count assertions for the new
  `outboxEvents` inserts (2 pre-existing `bulkCreateEntities` assertions needed
  `toHaveBeenCalledTimes(1)` → `(2)`, since bulk create now does one batched insert into
  `entityInstances` plus one batched insert into `outboxEvents`).
- Branch: `fix/PLAT-126-entity-created-triggers`. Plan-lock approved by human before any
  source edit; the `entity.assigned` semantics question (see above) was asked and answered
  before drafting the plan, since the docs didn't disambiguate and the schema can't
  represent every option.

### /security-review finding (fixed before shipping): PII leaves the platform via the new outbox path

The security review flagged that `entity.created`'s outbox payload carried the entity's full,
unredacted field map (`fieldsWithFormulas`) — including `pii`/`financial`-classified fields —
whereas every other secondary store that persists field values (`workflow_events.metadata`,
`admin_audit_log`) redacts them first. Since `entity.created` never fired before this PR, this
was the first path that let raw PII reach a table an admin-configured `webhook` automation
action can forward to an external URL. Adversarially verified as real (not pre-existing —
confirmed the entire outbox-insert block is new in this diff).

Fixed: added `packages/entity-engine/src/redact.ts` (`redactFields`/`buildSensitivityMap`,
same contract as `workflow-engine`'s equivalent, defined locally rather than imported —
same dependency-direction reason as the event types above) and applied it to the `fields`
value in both `createEntity`'s and `bulkCreateEntities`'s outbox payloads before insert.

**While writing the Prove-It test for this fix, found a second, unrelated pre-existing bug**:
`addEntityField` (`packages/entity-engine/src/engine.ts`) accepts a `sensitivity` parameter
and threads it through the whole call chain — including the real API route
(`POST /entity-types/:id/fields`, `apps/api/src/routes/entity-types/fields/create-field.ts`,
already correctly forwarding `input.sensitivity`) — but its DB insert never actually included
the `sensitivity` column, so every custom field ever created via that route silently fell back
to the column default (`'internal'`), regardless of what the caller specified. This meant any
tenant admin who marked a custom field `pii` or `financial` today gets none of the redaction
protection everywhere that classification is supposed to enable — a bigger, platform-wide gap
than the outbox-specific one above. No existing test caught it because the only test touching
`sensitivity` (`audit-hook.test.ts`) mocks field metadata directly rather than exercising the
real insert. One-line fix: added the missing `sensitivity: field.sensitivity` to the insert
`.values()`. The new isolation test's redaction case exercises this real path end-to-end
(creates the field via `addEntityField` with `sensitivity: "pii"`, then asserts redaction),
so it doubles as the regression test for both bugs together.

### /code-review findings (8-angle fan-out) — fixed before shipping

- **`workflow_events.metadata` still leaked raw PII, and my own code comment falsely claimed
  it didn't.** The first redaction fix only covered the new `entity.created` outbox path;
  `createEntity`'s pre-existing `workflow_events` insert (for workflow-attached entities) and
  `updateEntity`'s field-diff (`changed[key] = {old, new}`) both still wrote raw field values.
  Fixed both: `createEntity` now redacts once and reuses the result for both writes;
  `updateEntity`'s diff now computes on **raw** values (redacting first would make every
  pii/financial change look like a no-op, since both sides collapse to the same
  `"[REDACTED]"` string) and redacts only what gets stored.
- **`assignedBy` on `entity.assigned` was computed inconsistently across all 6 call sites** —
  `createEntity` used `actorId ?? createdBy`, `updateEntity`'s two branches and
  `bulkUpdateEntities`'s two branches used `actorId ?? null` (dropping the creator fallback),
  and `bulkCreateEntities` used `createdBy` alone (dropping `actorId` entirely — it never had
  access to it, since the per-row `auditMeta` didn't carry it). Extracted a single
  `resolveAssignedBy(actorId, createdBy)` and used it everywhere, and added `actorId` to
  `bulkCreateEntities`'s parallel `auditMeta` array so the real actor is available per row.
- **`bulkCreateEntities`'s outbox flatMap rebuilt a sensitivity map per row** instead of using
  the function's existing per-type cache (`typeMetaCache`) — hoisted to a `getSensitivityMap`
  helper keyed by `entityTypeId`.
- **`bulkUpdateEntities` did one `outboxEvents` insert per item inside its `Promise.all`**
  instead of batching like `bulkCreateEntities` does — N round trips instead of 1 for a
  100-item bulk update. Collected rows into an array and moved the insert to after
  `Promise.all`.
- **Isolation test file exceeded testing-conventions.md's ~200-line split threshold** (264
  lines, two logical concerns). Split into
  `entity-created-trigger.isolation.test.ts` and `entity-assigned-trigger.isolation.test.ts`.

Declined to fix (documented instead):
- **#120 is now more exploitable, not just reachable**: `entity.created` fires on *every*
  entity creation with zero tenant configuration required, unlike `workflow.transitioned`
  which needs a deliberately configured multi-step workflow to loop. Still out of scope for
  #126 (approved plan boundary), but the severity note is worth carrying into whoever picks
  up #120 next.
- **Helpdesk seed's `WHERE NOT EXISTS` idempotency guard matches on rule name, not content**,
  so tenants that installed the module before this PR's action-shape fix keep the old broken
  payload forever (reseeding doesn't overwrite existing rows, and blindly overwriting could
  destroy a tenant's manual customization). Not fixed: no real tenants are onboarded yet
  (Phase 2 complete, pilot NOT YET per the consulting review), so current-world impact is
  zero; a backfill migration would need a product decision about detecting "still has the
  broken shape" vs. "tenant customized it," not just a mechanical fix.
- **No backfill for `entity_fields` rows already stuck at `sensitivity = 'internal'`** from
  the `addEntityField` bug (fixed above, going forward only) — same reasoning: which existing
  fields were *meant* to be `pii`/`financial` isn't mechanically knowable, needs a tenant/
  product decision, not an automated fix.

### Verification (CI-equivalent local run, same method as PR #135)

- pnpm typecheck: PASS
- pnpm lint: N/A — discovered `pnpm lint` (`turbo run lint`) is a pre-existing repo-wide
  no-op: no package.json anywhere defines a `lint` script, so `turbo run lint` matches
  nothing and trivially succeeds. Confirmed by running `npx eslint` directly on the repo
  root (found real pre-existing errors in untouched files) and then scoped to just this
  PR's changed files (zero errors/warnings). Worth a follow-up issue — flagging, not fixing,
  since it's unrelated to #126 and affects the whole repo/CI, not just this change.
- pnpm test: PASS (327/327, up from 321)
- pnpm test:isolation: PASS (118/118, up from 112 — the new entity-created/entity-assigned
  trigger tests, split across two files)

### Next

1. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
2. Doc fixes from the review: `roadmap-tracker.md` Phase 2 gate wording, `platform-vision.md`
   Mermaid diagram, ADR-004 reference — already shipped in PR #137 (awaiting team merge
   approval as of this session)
3. Remaining hardening items #120, #123, #124, #125, #128, #129
4. #136 — design + implement RLS policies for `entity_types`/`workflows`/`workflow_states`/
   `workflow_transitions`
5. New: file a follow-up issue for the `pnpm lint` no-op discovered above

### Open questions

- None blocking on #126 itself. Flagging for awareness: `bulkCreateEntities`/
  `bulkUpdateEntities` now emit outbox events per existing helpdesk-seed-style rules — any
  tenant that already has module seeds installed will see previously-silent automations
  start firing on the next deploy (not a bug, a behavior change worth a changelog note,
  same category as the entity.created note in the original consulting review).

---

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
