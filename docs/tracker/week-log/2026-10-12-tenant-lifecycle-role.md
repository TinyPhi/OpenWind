# 2026-10-12 — tenant_lifecycle_role: who may create and change tenants

**Session type:** Bug fix with a grant-model decision (owner-chosen)
**Branch:** `fix/tenant-lifecycle-role`

- **Found while manually testing sandbox creation.** With the provisioning key and the audit fix
  (#868) in place, the Zitadel org was created, then `INSERT INTO tenants` was refused and the
  job rolled back. Migrations 0061/0062 (#404–#408) deliberately left `app_user` with only
  `SELECT` and `UPDATE (config, updated_at)` on `tenants`. But the API and worker connect as
  `app_user` (docker-compose.yml), and several paths still wrote `tenants` on that connection:
  - tenant provisioning (API `provisionTenant` and the sandbox provisioning worker)
  - suspend, reactivate and schedule-deletion
  - the sandbox delete status flip
  - tenant-purge's "purged" flip
  - the sandbox T11 rollback delete

  CI connects as a superuser, so none of these grants were ever exercised.

- **Decision (owner, from three options in BLOCKERS.md):** a dedicated narrow role, not a
  privileged worker connection and not a dev-only grant. Migration
  `0142_tenant_lifecycle_role.sql` creates `tenant_lifecycle_role`:
  - `NOLOGIN NOBYPASSRLS`, granted to `app_user WITH INHERIT FALSE`, the same shape as
    `platform_admin_role` (0135)
  - `SELECT, INSERT, DELETE` on `tenants`, and `UPDATE` only on `status`, `suspended_at`,
    `deletion_scheduled_at`, `updated_at`
  - `app_user`'s own grants are untouched, so #404–#408 still applies to every ordinary
    request
- **Code:** `withTenantLifecycleContext()` in `@platform/db`, a transaction plus
  `SET LOCAL ROLE`. It wraps exactly the statements above in `apps/api/src/lib/tenant-lifecycle.ts`,
  `sandbox-provisioning-worker.ts`, `sandbox-delete-worker.ts` and `tenant-purge.ts`.
  Config-only `tenants` updates (module install, rate limit, notification prefs) are still
  allowed for `app_user` and are unchanged.
- **Tests:**
  - `tenant-lifecycle-role.isolation.test.ts` (real Postgres): `app_user` still can't insert
    or change status; the role can insert, update lifecycle columns and delete; it is refused
    on `name`, `plan`, `config` and `is_sandbox`.
  - The unit-test mocks for the three files no longer give plain `db` any write builders, so a
    `tenants` write on the plain connection throws. Against the old code, 15 worker and 11 API
    tests fail.
  - The existing real-database sandbox-delete and tenant-purge isolation tests pass with the
    role switch.
- **Security review (no exploitable issues), two items fixed:**
  - **Pre-existing provisioning rollback bug.** The job row's `result_tenant_id` references the
    tenant with no `ON DELETE` action, so the T11 rollback's tenant delete failed on the FK
    and left an orphaned sandbox tenant. The rollback now clears that reference first. The
    unit test asserts it happens before the delete.
  - **Test gap.** The suite connects as a superuser, which may `SET ROLE` to anything. A new
    case runs `SET LOCAL SESSION AUTHORIZATION app_user` first, proving a real `app_user`
    session can switch into the role (the production path).
- **Open:**
  - This is a new database-role pattern; a short human-authored ADR note should record it.
  - Migration number `0142`: the next after main's `0141` (#859). #880 also adds a `0142` (the
    sandbox trial function); whichever of the two merges second must take the next number **and**
    a later journal `when`, because drizzle's migrator skips any entry older than the last applied.

## 2026-10-13: review round 2 fixes

- [A] After merging main (which now has #859's `0141`), the migration is
  `0142_tenant_lifecycle_role.sql` with journal `idx` 142, matching its number. Its `when` is later
  than every existing entry. Before this it had been idx 140, then 0143/idx 141.
- [B] `provisionTenant`, `suspendTenant`, `reactivateTenant` and `scheduleTenantDeletion` now write
  their `admin_audit_log` entry inside `withTenantContext(tenantId, …)`, the same fix #868 made for
  the sandbox workers. On plain `db` the RLS-protected insert was rejected for `app_user` after the
  tenants write had committed, so each action returned a 500. Unit tests assert each write uses the
  tenant-context transaction; they fail on the previous code.
