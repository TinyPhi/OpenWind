# Module Upgrade Workflow

> Versioned, additive upgrades that carry new module seed config (fields, rules, view configs) to
> tenants that already have the module installed. For platform operators; fixes #673.

status: draft (review round 2 pending)
created: 2026-10-09
updated: 2026-10-09

---

## §G Goal

- Tenant installed before a seed change gets the new config without reinstall, re-seed or hand SQL.
- #662 config gap closed: pre-#662 helpdesk tenants gain the `department` field definition.
- Upgrades never overwrite, delete, or (after baseline) resurrect tenant data.
- Operator sees per-tenant/per-module drift (applied vs available version) and can preview any upgrade.
- Baseline + history catch-up done now, while no live tenant exists (resurrection risk is nil today).

## §C Constraints

| constraint                | value                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| module code               | upgrade files are SQL only, `modules/<slug>/upgrades/<version>/*.sql`; zero TypeScript in `modules/` (ADR-004)                                                                                                                                                                                                                                                                                                                         |
| v1 scope of change        | additive only: entity fields (`is_required=false`), automation rules, view-config rows for a slug the tenant lacks                                                                                                                                                                                                                                                                                                                     |
| deferred                  | workflow states/transitions (no unique key; rename/delete ambiguity; O3), view-config column additions (an UPDATE), `initial_state`/`sort_order`/`requires_fields` edits                                                                                                                                                                                                                                                               |
| non-additive seed changes | not an upgrade; ship a paired numbered migration (precedent 0125); CI guard accepts it as the exemption                                                                                                                                                                                                                                                                                                                                |
| idempotency               | every upgrade file safe to run twice; re-applying a version is a no-op; no non-idempotent file may ever exist                                                                                                                                                                                                                                                                                                                          |
| tenancy                   | files run under `SET LOCAL ROLE app_user` + tenant GUC (RLS applies, ADR-001); only quoted `'{TENANT_ID}'`/`'{MODULE_ID}'` tokens substituted, as `installModule` does                                                                                                                                                                                                                                                                 |
| entity-type lookup        | `SELECT … FROM entity_types WHERE tenant_id='{TENANT_ID}' AND module_id='{MODULE_ID}' AND name='x'`; zero rows = skip, never a NOT NULL error                                                                                                                                                                                                                                                                                          |
| atomicity                 | new additive `@platform/db` primitive runs N SQL strings + the version-row write in ONE tenant-context transaction (dry run: same path, forced ROLLBACK). `executeRawInTenantContext` opens its own txn per call, so it cannot be used per file                                                                                                                                                                                        |
| ordering                  | versions compared as semver (dir names match `^\d+\.\d+\.\d+$`), applied ascending; N+1 failure blocks N+2 for that (tenant, module) only                                                                                                                                                                                                                                                                                              |
| locking                   | row lock `SELECT … FROM tenant_module_versions … FOR UPDATE NOWAIT` (or `pg_try_advisory_xact_lock`) inside the version txn; `lock_not_available` = "already running". NOT session advisory locks: PgBouncer is `POOL_MODE: transaction` (#752). Install and reinstall take the same lock                                                                                                                                              |
| state                     | new RLS table `tenant_module_versions` (ADR-007 pattern); `tenants.config.installed_modules` unchanged                                                                                                                                                                                                                                                                                                                                 |
| version authority         | module's available version = highest `upgrades/<version>/` dir (else `0.0.1`); `seedRegistry` derives `modules.version` from files instead of hard-coding/resetting it                                                                                                                                                                                                                                                                 |
| lint                      | upgrade files pass an allowlist enforced by a real SQL parser: `INSERT … SELECT/VALUES` with `ON CONFLICT DO NOTHING` or `WHERE NOT EXISTS`; rejects DELETE, UPDATE, TRUNCATE, `ON CONFLICT DO UPDATE`, data-modifying CTEs, `DO $$`, `SET/RESET ROLE`, `set_config`, unknown tokens                                                                                                                                                   |
| required fields           | fields added by an upgrade are never `is_required` (create-mode validation would break existing API callers, ADR-012)                                                                                                                                                                                                                                                                                                                  |
| cache                     | after commit, call existing `invalidateSchemaCache` for every module entity type of the tenant; best-effort (Redis down => within the 60 s TTL). Schema-cache design untouched (#4 off-limits)                                                                                                                                                                                                                                         |
| deploy skew               | a version applies only if its upgrade files exist in the running build; registry version alone is not enough                                                                                                                                                                                                                                                                                                                           |
| service placement         | upgrade service lives in `apps/worker` (worker cannot import `apps/api`); any future API route enqueues a BullMQ job (sandbox-reset pattern)                                                                                                                                                                                                                                                                                           |
| operator surface v1       | CLI shipped in the worker image on the privileged connection (tenant-purge pattern). HTTP routes are BLOCKED on a human ADR-022 amendment: platform_admin is sandbox-scoped, "never business data" (ADR-022:37)                                                                                                                                                                                                                        |
| installers                | both `ModuleService.installModule` and `installCoreModulesForSandbox` write/respect version rows                                                                                                                                                                                                                                                                                                                                       |
| active tenants            | skip when `isTenantActive` is false or (sandbox) `isTenantTrialActive` is false; they catch up on reactivation                                                                                                                                                                                                                                                                                                                         |
| audit                     | `admin_audit_log` actions `module_upgrade.applied\|failed\|dry_run` (two-segment, CHECK-constraint migration + `AuditAction` type update, precedent 0136/0138); `resource_id` = `modules.id`; counts are row-count deltas per table                                                                                                                                                                                                    |
| last_error                | SQLSTATE + file name only (Postgres error detail can contain tenant values)                                                                                                                                                                                                                                                                                                                                                            |
| out of scope              | overwriting/deleting tenant rows; propagating changed labels/options/defaults; fixing already-seeded buggy rows (hand migration, cf. #126); sample instance data (multi-org-sandbox T9); instance backfill of `department` on existing tickets (separate owner-approved task); uninstall/reinstall data semantics (ADR-004 CF-02); plugin migrations (ADR-011); UI; stable seed-key column for renamed rules (schema change, deferred) |
| parallel approval         | untouched (#65)                                                                                                                                                                                                                                                                                                                                                                                                                        |

## §I Interfaces

**Upgrade files.** `modules/<slug>/upgrades/<version>/NNN_<name>.sql`. `seed/` stays the fresh-install
state. Baseline `0.0.1` = each module's oldest seed in git, kept as test fixtures under
`tests/fixtures/module-baselines/<slug>/` (not under `modules/`). `0.0.2` is the history catch-up
(fields/rules added since baseline, e.g. #585 severity, #597/#600 helpdesk rules, #662 department,
#815 core-module rules, #680 vendor-approval items).

**Table `tenant_module_versions`** (tenant-scoped, RLS, `app_user` grants, down migration):

| column          | notes                            |
| --------------- | -------------------------------- |
| tenant_id       | PK part, FK tenants              |
| module_slug     | PK part                          |
| applied_version | text; last fully applied version |
| applied_at      | timestamptz                      |
| last_error      | text null; SQLSTATE + file name  |
| next_attempt_at | timestamptz null; sweep backoff  |

Analytics annotation: `excluded (operational bookkeeping)`. Added to tenant-purge deletes
(`PURGED_TENANT_TABLES`) and the erasure coverage fixtures.

**CLI (v1, apps/worker).**

- `upgrade-modules status [--module M] [--tenant T]` → drift: `{tenantId, moduleSlug, applied, available, lastError}`.
- `upgrade-modules run --module M [--tenant T] [--dry-run]` → per (tenant, module) `{from, to, added:{fields,rules,viewConfigs}, error?}`; counts are row-count deltas. Omitted tenant = all behind tenants (enqueued as a job).

**Sweep.** BullMQ job in `apps/worker`: bounded batches, backoff via `next_attempt_at`, kill switch and
per-module pause flag stored in `platform_settings` (module-level, not tenant-scoped), active-tenant guard.

**Blocked (human ADR-022 amendment first).** Platform-admin HTTP routes mirroring the CLI; must enqueue, never run inline.

## §R Requirements

R1: Existing tenants receive in-scope module config added in later versions.
✓ pre-#662 helpdesk fixture has the `department` field definition (select, same options) after upgrade
✓ upgraded tenant's natural keys (fields, rules, view-config slugs) are a superset of a fresh install at the same version

R2: Upgrade is idempotent.
✓ second run: zero row-count change, `applied_version` unchanged, no error
✓ tenant that already has the new field (installed after the seed change) upgrades cleanly with no duplicate

R3: Upgrade never overwrites or deletes tenant data.
✓ snapshot of tenant-edited field options, renamed workflow, customised states/transitions, disabled rules identical after upgrade
✓ conflicting tenant field (same name, different definition) is kept unchanged

R4: Items a tenant deleted are not re-added by versions published after its baseline.
✓ tenant deletes a non-system field/rule at version N; upgrade to N+1 (which does not re-introduce it) leaves it absent
✓ tenant-deleted or renamed entity type: upgrade inserts nothing for it and does not error (zero-row lookup)
✓ catch-up version `0.0.2` MAY re-add deleted non-system items for tenants baselined at `0.0.1`; this is documented behaviour

R5: Tenant isolation holds.
✓ upgrading tenant A reads/writes no tenant B rows
✓ tenant cannot read another tenant's `tenant_module_versions` rows (isolation test, RLS + explicit filter)
✓ v1 exposes no HTTP surface: no route can trigger or read upgrades

R6: Failures are contained and recoverable.
✓ operator run: broken file for tenant A rolls A back to its prior version, `last_error` set, tenant B still upgrades in the same run
✓ failed N+1 retried with backoff; N+2 never applied before N+1
✓ no partial version: all of a version's files and its version-row update commit together, or none

R7: Operators can see drift.
✓ `status` lists exactly the (tenant, module) pairs with applied < available, matching a known fixture
✓ inactive tenants and expired sandboxes are reported skipped, not behind-and-failing
✓ installed module with no version row is treated as baseline `0.0.1`

R8: Dry run is safe and truthful.
✓ `--dry-run` changes no tenant config and no version row (row counts identical before/after)
✓ dry-run `added` counts equal the counts a real run then reports

R9: Seed and upgrades converge.
✓ per module: install baseline fixture + all upgrade files yields natural keys ⊇ install of latest `seed/`
✓ CI fails when `modules/<slug>/seed/` changes without an `upgrades/<next>/` dir, a paired numbered migration, or an explicit exemption token
✓ the guard itself has a test (positive and negative cases)

R10: Concurrent triggers don't collide.
✓ CLI run during a sweep, same (tenant, module): second caller gets "already running", no double apply
✓ two sweep workers never upgrade the same (tenant, module) simultaneously
✓ install/reinstall of the module during an upgrade blocks or fails fast; never interleaves

R11: Install and reinstall keep version rows correct.
✓ fresh install (both installers) records `applied_version` = module's available version
✓ reinstall after uninstall resets the row to the available version
✓ sweep touches only tenants that currently have the module installed

R12: New config is effective promptly.
✓ after upgrade, entity validation sees the new field immediately, or within the 60 s TTL if Redis invalidation is unavailable

R13: The automatic sweep is controllable.
✓ kill switch halts it without a deploy; in-flight (tenant, module) finishes or rolls back cleanly
✓ batches are bounded; first failure for a module pauses further tenants for that module until an operator clears the pause (module-level flag)

R14: Upgrade files are mechanically constrained.
✓ allowlist lint accepts every legitimate file and rejects each forbidden construct (DELETE, UPDATE, DO block, data-modifying CTE, SET ROLE, `DO UPDATE`, unknown token) in tests
✓ lint runs in CI and in the loader (a file that fails lint is never executed)

R15: The new table is erasable.
✓ tenant purge deletes `tenant_module_versions` rows; erasure-table-coverage-guard isolation test passes without an exemption

## §V Invariants

- Upgrade SQL never mutates or deletes an existing tenant row (allowlist-enforced, not regex).
- Entity types resolve via `(tenant_id, module_id, name)`; absent => skip.
- `applied_version` advances only after every file of that version committed in the same transaction.
- `seed/` and (`baseline` + `upgrades/`) agree by natural key on every PR touching either; non-additive change needs a paired numbered migration.
- No upgrade path reads or writes outside its own `{TENANT_ID}`; no upgrade SQL can change role or tenant GUC.
- Fields added by an upgrade are optional.
- Locks are transaction-scoped (PgBouncer transaction pooling); no session advisory locks.
- Every new table: RLS, explicit `tenant_id` filter in queries, analytics annotation, isolation test, purge coverage.

## §T Tasks

Priority: P0 > P1 > P2 > P3. Order reflects: right for the user need, meets standards, heavy lifting early.

| id  | task                                                                                                                                                                                                     | phase  | status                           | depends  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------- | -------- |
| T0  | HUMAN: author ADR-004 follow-up accepting CF-03 (versioned additive delta) and CF-04 (tenant row wins); state whether MT-04/WE-01 are covered or out of scope                                            | 0      | todo (human)                     | —        |
| T1  | Migration: `tenant_module_versions` + RLS + `app_user` grants + indexes + analytics annotation + down migration; tenant-purge + erasure-coverage rows; isolation tests                                   | 1 (P0) | todo                             | T0       |
| T2  | `@platform/db` primitive: run N SQL strings + version-row write in one tenant-context txn, with dry-run rollback (additive API, surface in PR per agent-behaviour)                                       | 1 (P0) | todo                             | T0       |
| T3  | Upgrade file format + loader (semver ordering, `module_id` tokens) + allowlist SQL-parser lint + `seedRegistry` version derivation                                                                       | 1 (P0) | todo                             | T0       |
| T4  | Upgrade service in `apps/worker`: row-lock, per-version txn, rollback, cache invalidation (post-commit, all module entity types), active-tenant guard, SQLSTATE-only errors                              | 1 (P0) | todo                             | T1,T2,T3 |
| T5  | Baseline fixtures (`tests/fixtures/module-baselines/<slug>/` from git history) + history audit + `0.0.2` catch-up upgrades per module (#585, #597/#600, #662, #680, #815); pre-#662 fixture              | 1 (P0) | todo                             | T3       |
| T6  | Baseline backfill (rows at `0.0.1` for existing tenant+module) + both installers write rows + reinstall reset + lock sharing with install/reinstall                                                      | 1 (P0) | todo                             | T1,T4    |
| T7  | Convergence harness (R9): baseline + upgrades vs latest seed, all modules, by natural key                                                                                                                | 1 (P0) | todo                             | T4,T5    |
| T8  | CI guard in `scripts/check-contribution-guardrails.sh` (seed change needs upgrade dir / paired migration / exemption) + its tests; extend module-seed-automation-rules integration test to `upgrades/**` | 1 (P0) | todo                             | T3       |
| T9  | CLI `upgrade-modules status\|run [--dry-run]` in `apps/worker`; audit-action migration + `AuditAction` type; docs runbook (`docs/local-setup.md`)                                                        | 2 (P1) | todo                             | T4,T6    |
| T10 | Automatic sweep: bounded batches, backoff, kill switch + module pause flag in `platform_settings`, metrics (ADR-015, tenant not a label)                                                                 | 3 (P2) | todo                             | T9       |
| T11 | HTTP platform-admin routes (enqueue, never inline)                                                                                                                                                       | 4 (P3) | blocked: human ADR-022 amendment | T9       |
| T12 | Docs: CHANGELOG, week-log, specs index, tracker, ADR-004 follow-up link                                                                                                                                  | any    | todo                             | T9       |

Open items (owner decisions, not guessed):

- **O1 (decided).** Version authority = highest `upgrades/` dir, semver-compared.
- **O2 (decided).** Catch-up `0.0.2` may re-add deleted non-system items; accepted (no live tenant today).
- **O3 workflow states/transitions.** Deferred. Decide whether to add unique `(workflow_id, name)` on states and `(workflow_id, from_state, to_state)` on transitions now, while no live tenant exists (cheap now, hard later), which would unlock additive state/transition upgrades.
- **O4 renamed rules** are re-added as duplicates (rules dedupe by name). Accepted for v1; a stable seed-key column is deferred.
- **O5** migration numbers are taken at implementation time (next free after open PRs; journal-merge trap).
- **O6 (decided).** Pause flag is module-level, in `platform_settings`.
- **O7 `department` instance backfill** for existing tickets: separate task, owner approval needed.
- **O8** whether production tenants' module entity types all have `module_id` set (one query; moot if no live tenant).

phase gate: all unit + integration + isolation tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed                                                           | root cause                                                                                   | promoted to §V?                                |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| B1  | Draft v1 specified a session advisory lock                            | PgBouncer transaction pooling leaks/re-enters session locks (#752); caught in review round 1 | yes: "locks are transaction-scoped"            |
| B2  | Draft v1 specified per-file `executeRawInTenantContext` for atomicity | helper opens its own txn per call                                                            | yes: single-txn primitive (§C)                 |
| B3  | Draft v1 gave platform-admin write power over real tenants            | ADR-022 limits the role to sandboxes                                                         | no: CLI-only v1, HTTP blocked on ADR amendment |

---

_spec is source of truth — update as decisions are made_
