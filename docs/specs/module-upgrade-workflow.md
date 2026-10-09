# Module Upgrade Workflow

> Versioned, additive upgrades that carry new module seed config (fields, rules, view configs) to
> tenants that already have the module installed. For platform operators; fixes #673.

status: draft (review round 2 addressed; round 3 optional)
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

| constraint                | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | ------ | --- | --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| module code               | upgrade files are SQL only, `modules/<slug>/upgrades/<version>/*.sql`; zero TypeScript in `modules/` (ADR-004)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| v1 scope of change        | additive only: entity fields (`is_required=false`), automation rules, view-config rows for a slug the tenant lacks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| deferred                  | workflow states/transitions (no unique key; rename/delete ambiguity; O3), view-config column additions (an UPDATE), `initial_state`/`sort_order`/`requires_fields` edits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| non-additive seed changes | not an upgrade; ship a paired numbered migration (precedent 0125); CI guard accepts it as the exemption                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| idempotency               | every upgrade file safe to run twice; re-applying a version is a no-op; no non-idempotent file may ever exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| tenancy                   | files run under `SET LOCAL ROLE app_user` + tenant GUC (RLS applies, ADR-001); only quoted `'{TENANT_ID}'`/`'{MODULE_ID}'` tokens substituted, as `installModule` does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| entity-type lookup        | `SELECT … FROM entity_types WHERE tenant_id='{TENANT_ID}' AND module_id='{MODULE_ID}' AND name='x'`; zero rows = skip, never a NOT NULL error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| atomicity                 | new additive `@platform/db` primitive runs, in ONE tenant-context transaction: the lock, N SQL strings, and a callback for Drizzle writes on the same transaction (version row, `installed_modules`). Dry run: same path, forced ROLLBACK. `executeRawInTenantContext` opens its own txn per call, so it cannot be used per file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ordering                  | versions compared as semver (dir names match `^\d+\.\d+\.\d+$`), applied ascending; N+1 failure blocks N+2 for that (tenant, module) only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| locking                   | `pg_try_advisory_xact_lock(hashtextextended('module-upgrade:'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |     | tenant |     | ':' |     | slug, 2))`as the primitive's first statement (executor uses seed 0, tenant lock seed 1); false = "already running". Works when no version row exists yet. NOT session advisory locks: PgBouncer is`POOL_MODE: transaction` (#752). Install and reinstall run on the same primitive, so they take the same lock |
| state                     | new RLS table `tenant_module_versions` (ADR-007 pattern); `tenants.config.installed_modules` unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| version authority         | module's available version = highest `upgrades/<version>/` dir (else `0.0.1`); `seedRegistry` derives `modules.version` from files instead of hard-coding/resetting it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| lint                      | upgrade files pass an allowlist: only `INSERT … SELECT/VALUES` into `entity_fields`, `automation_rules`, `view_configs`, with `ON CONFLICT DO NOTHING` or `WHERE NOT EXISTS`; function allowlist (`gen_random_uuid` only); `entity_fields` inserts use `INSERT … SELECT … FROM entity_types WHERE tenant_id/module_id/name` (zero rows = skip, not `VALUES ((SELECT …))`); `is_required` literal `false`; `view_configs` inserts gated on the entity type existing; rejects DELETE, UPDATE, TRUNCATE, `DO UPDATE`, data-modifying CTEs, `DO $$`, `SET/RESET ROLE`, `set_config`, unknown tokens. Baseline fixtures are excluded. No SQL parser exists in the repo: runs in CI/packaging and emits a content-hash manifest the loader verifies, so the Alpine worker image needs no runtime parser (owner to confirm, O10; parser chosen via `source-driven-development`) |
| required fields           | fields added by an upgrade are never `is_required` (create-mode validation would break existing API callers, ADR-012)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| cache                     | after commit, call existing `invalidateSchemaCache` for every module entity type of the tenant; best-effort (Redis down => within the 60 s TTL). Schema-cache design untouched (#4 off-limits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| deploy skew               | a version applies only if its upgrade files exist in the running build; registry version alone is not enough                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| service placement         | upgrade service lives in `apps/worker` (worker cannot import `apps/api`); any future API route enqueues a BullMQ job (sandbox-reset pattern)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| operator surface v1       | CLI shipped in the worker image (entrypoint named in T9). In compose the worker connects as `app_user` under RLS (CI connects as superuser), so cross-tenant reads list tenants first (`tenants` has no RLS) and read each tenant's rows inside `withTenantContext`; isolation tests run as `app_user`. HTTP routes are BLOCKED on a human ADR-022 amendment: platform_admin is sandbox-scoped, "never business data" (ADR-022:37)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| installers                | both `ModuleService.installModule` and `installCoreModulesForSandbox` move onto the primitive: lock, all seed files, workflow rename, `installed_modules`, version row in one transaction. Behaviour change: install becomes all-or-nothing (owner to confirm, O9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| active tenants            | skip when `isTenantActive` is false or (sandbox) `isTenantTrialActive` is false; they catch up on reactivation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| audit                     | `admin_audit_log` actions `module_upgrade.applied\|failed\|dry_run` (two-segment; CHECK-constraint migration + `AuditAction` type update land in T1, before any code writes them; precedent 0136/0138); `resource_id` = `modules.id`; counts are row-count deltas per table (rows whose `xmin` is the current transaction, so concurrent tenant commits are not counted); actor = `system`, `actorId` from a required `--operator` flag (O11)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| last_error                | SQLSTATE + file name only (Postgres error detail can contain tenant values)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| threat model              | STRIDE per `security.md`: spoofing/repudiation (CLI actor via `--operator`, audit entries); tampering (upgrade files: lint + manifest hash + code review); info disclosure (`last_error` SQLSTATE only, RLS on the table); DoS (bounded batches, per-module pause, kill switch); elevation (no HTTP surface, `app_user` role, lint forbids `SET ROLE`). Full table in the T1 PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| out of scope              | overwriting/deleting tenant rows; propagating changed labels/options/defaults; fixing already-seeded buggy rows (hand migration, cf. #126); sample instance data (multi-org-sandbox T9); instance backfill of `department` on existing tickets (separate owner-approved task); uninstall/reinstall data semantics (ADR-004 CF-02); plugin migrations (ADR-011); UI; stable seed-key column for renamed rules (schema change, deferred)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| parallel approval         | untouched (#65)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## §I Interfaces

**Upgrade files.** `modules/<slug>/upgrades/<version>/NNN_<name>.sql`. `seed/` stays the fresh-install
state. Baseline `0.0.1` = each module's oldest seed in git, kept as test fixtures under
`apps/worker/tests/fixtures/module-baselines/<slug>/` (inside a workspace so Turbo tracks it; not under
`modules/`; the lint skips it). Early fixtures predate migration 0125 and contain `textarea` field types;
comparison is by natural key, so this does not matter. `0.0.2` is the history catch-up and is needed only
for helpdesk (#585 severity, #597/#600 rules, #662 department) and the six core modules (#815 rules).
vendor-approval (one commit, #680) and tender (only #685, handled by migration 0125) need none.

**Table `tenant_module_versions`** (tenant-scoped, RLS, `app_user` grants, down migration):

| column          | notes                            |
| --------------- | -------------------------------- |
| tenant_id       | PK part, FK tenants              |
| module_slug     | PK part                          |
| applied_version | text; last fully applied version |
| applied_at      | timestamptz                      |
| last_error      | text null; SQLSTATE + file name  |
| next_attempt_at | timestamptz null; sweep backoff  |

Index: `(module_slug, next_attempt_at)` for the sweep query. A missing row means baseline `0.0.1` (lazy; no backfill migration).

Analytics annotation: `excluded (operational bookkeeping)`. Added to tenant-purge deletes
(`PURGED_TENANT_TABLES`) and the erasure coverage fixtures.

**CLI (v1, apps/worker).**

- `upgrade-modules status [--module M] [--tenant T]` → drift: `{tenantId, moduleSlug, applied, available, lastError}`.
- `upgrade-modules run --module M [--tenant T] [--dry-run]` → per (tenant, module) `{from, to, added:{fields,rules,viewConfigs}, error?}`; counts are row-count deltas. Omitted tenant = all behind tenants (enqueued as a job). Entry point: `apps/worker/src/cli/upgrade-modules.ts`, a `package.json` script, run via `docker compose exec ow-worker …` (note `@platform/config` validates the full env at startup).

**Sweep.** BullMQ job in `apps/worker`: bounded batches, backoff via `next_attempt_at`, kill switch and
per-module pause flag stored in `platform_settings` (module-level, not tenant-scoped; the table is a single typed row, so T10 adds `module_upgrades_enabled boolean` and `module_upgrades_paused_modules text[]` by migration; the flags are CLI-only and never exposed by `PATCH /admin/platform-settings`, which is tenant-reachable), active-tenant guard.

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
✓ `status` run as `app_user` (not superuser) lists exactly the (tenant, module) pairs with applied < available, matching a known fixture
✓ inactive tenants and expired sandboxes are reported skipped, not behind-and-failing
✓ installed module with no version row is treated as baseline `0.0.1` (lazy; no backfill)

R8: Dry run is safe and truthful.
✓ `--dry-run` changes no tenant config and no version row (row counts identical before/after)
✓ dry-run `added` counts equal the counts a real run then reports (counted by `xmin`, so concurrent tenant commits do not skew them)

R9: Seed and upgrades converge.
✓ per module: install baseline fixture + all upgrade files yields natural keys ⊇ install of latest `seed/`; natural keys: fields = (entity type name, field name), view configs = `entity_type_slug`, rules = name; the harness installs each module alone in a fresh tenant so rules can be attributed
✓ CI fails when `modules/<slug>/seed/` changes without an `upgrades/<next>/` dir, a paired numbered migration, or an explicit exemption token
✓ the guard itself has a test (positive and negative cases)

R10: Concurrent triggers don't collide.
✓ CLI run during a sweep, same (tenant, module): second caller gets "already running", no double apply
✓ two sweep workers never upgrade the same (tenant, module) simultaneously
✓ install/reinstall of the module during an upgrade fails fast with "already running"; never interleaves
✓ the lock holds when no version row exists yet (first run, fresh-install race)

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
✓ lint also rejects: a target table outside the allowlist, a function outside the allowlist, `is_required` other than literal `false`, `VALUES ((SELECT …))` entity-type lookups, a view-config insert not gated on its entity type
✓ lint runs in CI/packaging and emits a manifest; the loader refuses any file whose hash is not in the manifest

R15: The new table is erasable.
✓ tenant purge deletes `tenant_module_versions` rows; erasure-table-coverage-guard isolation test passes without an exemption

## §V Invariants

- Upgrade SQL never mutates or deletes an existing tenant row (allowlist-enforced, not regex).
- Entity types resolve via `(tenant_id, module_id, name)`; absent => skip.
- `applied_version` advances only after every file of that version committed in the same transaction.
- `seed/` and (`baseline` + `upgrades/`) agree by natural key on every PR touching either; non-additive change needs a paired numbered migration.
- No upgrade path reads or writes outside its own `{TENANT_ID}`; no upgrade SQL can change role or tenant GUC.
- Fields added by an upgrade are optional.
- Locks are transaction-scoped and independent of row existence (PgBouncer transaction pooling); no session advisory locks.
- Audit actions exist in the CHECK constraint before any code writes them.
- Every new table: RLS, explicit `tenant_id` filter in queries, analytics annotation, isolation test, purge coverage.

## §T Tasks

Priority: P0 > P1 > P2. Order reflects: right for the user need, meets standards, heavy lifting early. #673 closes at the end of P0.

P0 PR slices (each independently reviewable): S1 = T1; S2 = T2; S3 = T3; S4 = T4 + T6; S5 = T5 + T7; S6 = T8; S7 = T9.

| id  | task                                                                                                                                                                                                                                                                  | phase  | status                           | depends  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------- | -------- |
| T0  | HUMAN: author ADR-004 follow-up accepting CF-03 (versioned additive delta) and CF-04 (tenant row wins); state whether MT-04/WE-01 are covered or out of scope                                                                                                         | 0      | todo (human)                     | —        |
| T1  | Migrations: `tenant_module_versions` + RLS + `app_user` grants + indexes + analytics annotation + down migration; `admin_audit_log` CHECK + `AuditAction` for `module_upgrade.*`; tenant-purge + erasure-coverage rows; STRIDE table; isolation tests (as `app_user`) | 1 (P0) | todo                             | T0       |
| T2  | `@platform/db` primitive: xact advisory lock + N SQL strings + Drizzle-callback in one tenant-context txn, dry-run rollback (additive API, surface in PR per agent-behaviour)                                                                                         | 1 (P0) | todo                             | T0       |
| T3  | Upgrade file format + loader (semver ordering, `module_id` tokens) + allowlist lint + packaging manifest + `seedRegistry` version derivation; parser chosen via `source-driven-development`                                                                           | 1 (P0) | todo                             | T0       |
| T4  | Upgrade service in `apps/worker`: lock via primitive, per-version txn, rollback, cache invalidation (post-commit, all module entity types), `isTenantActive` + `isTenantTrialActive` guards, SQLSTATE-only errors, `xmin` counts                                      | 1 (P0) | todo                             | T1,T2,T3 |
| T5  | Baseline fixtures (`apps/worker/tests/fixtures/module-baselines/<slug>/` from git) + `0.0.2` catch-up for helpdesk and the six core modules + pre-#662 fixture                                                                                                        | 1 (P0) | todo                             | T3       |
| T6  | Both installers moved onto the primitive (all-or-nothing install) + version rows on install + reinstall reset; no backfill migration (lazy baseline)                                                                                                                  | 1 (P0) | todo                             | T1,T2,T4 |
| T7  | Convergence harness (R9): baseline + upgrades vs latest seed, by natural key, one module per fresh tenant                                                                                                                                                             | 1 (P0) | todo                             | T4,T5    |
| T8  | CI guard in `scripts/check-contribution-guardrails.sh` (seed change needs upgrade dir / paired migration / exemption) + its tests; extend module-seed-automation-rules integration test to `upgrades/**`                                                              | 1 (P0) | todo                             | T3       |
| T9  | CLI `upgrade-modules status\|run [--dry-run] --operator` in `apps/worker` (entrypoint, script, compose invocation); runbook in `docs/local-setup.md`. #673 closes when this lands                                                                                     | 1 (P0) | todo                             | T4,T6    |
| T10 | Automatic sweep: bounded batches, backoff, kill switch + module pause flag (`platform_settings` migration), metrics (ADR-015, tenant not a label)                                                                                                                     | 2 (P1) | todo                             | T9       |
| T11 | HTTP platform-admin routes (enqueue, never inline)                                                                                                                                                                                                                    | 3 (P2) | blocked: human ADR-022 amendment | T9       |
| T12 | Docs: CHANGELOG, week-log, specs index, tracker, ADR-004 follow-up link                                                                                                                                                                                               | any    | todo                             | T9       |

Open items (owner decisions, not guessed):

- **O1 (decided).** Version authority = highest `upgrades/` dir, semver-compared.
- **O2 (decided).** Catch-up `0.0.2` may re-add deleted non-system items; accepted (no live tenant today).
- **O3 workflow states/transitions.** Deferred. Decide whether to add unique `(workflow_id, name)` on states and `(workflow_id, from_state, to_state)` on transitions now, while no live tenant exists (cheap now, hard later), which would unlock additive state/transition upgrades.
- **O4 renamed rules** are re-added as duplicates (rules dedupe by name). Accepted for v1; a stable seed-key column is deferred.
- **O5** migration numbers are taken at implementation time (next free after open PRs; journal-merge trap).
- **O6 (decided).** Pause flag is module-level, in `platform_settings`.
- **O7 `department` instance backfill** for existing tickets: separate task, owner approval needed.
- **O8 (decided, 2026-10-09).** The separate non-live instance was installed after 2026-08-07, so the git baseline covers it. Every module seed has set `entity_types.module_id` from `{MODULE_ID}` since the first commit (9192d9e), so the `module_id` lookup holds for every existing tenant.
- **O9** install becomes a single all-or-nothing transaction (needed for the shared lock). Owner to confirm.
- **O10** lint runs in CI/packaging with a manifest, not as a runtime parser in the worker image. Owner to confirm.
- **O11** CLI audit actor: `system` + required `--operator`. Owner to confirm.

phase gate: all unit + integration + isolation tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed                                                           | root cause                                                                                        | promoted to §V?                                  |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| B1  | Draft v1 specified a session advisory lock                            | PgBouncer transaction pooling leaks/re-enters session locks (#752); caught in review round 1      | yes: "locks are transaction-scoped"              |
| B2  | Draft v1 specified per-file `executeRawInTenantContext` for atomicity | helper opens its own txn per call                                                                 | yes: single-txn primitive (§C)                   |
| B3  | Draft v1 gave platform-admin write power over real tenants            | ADR-022 limits the role to sandboxes                                                              | no: CLI-only v1, HTTP blocked on ADR amendment   |
| B4  | Round-1 fix used `FOR UPDATE NOWAIT` on the version row               | locks nothing when the row does not exist (first run, install race)                               | yes: lock independent of row existence           |
| B5  | Audit-action migration sat in P1 while P0 code wrote audit entries    | would violate the 0138 CHECK constraint                                                           | yes: audit actions exist before code writes them |
| B6  | CLI assumed a privileged connection                                   | worker is `app_user` under RLS in compose, superuser in CI; tests pass while prod returns nothing | yes: isolation tests run as `app_user`           |

---

_spec is source of truth — update as decisions are made_
