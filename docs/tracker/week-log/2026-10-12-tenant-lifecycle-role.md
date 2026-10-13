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
  `0143_tenant_lifecycle_role.sql` creates `tenant_lifecycle_role`:
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
  - Migration number: landed as `0143` — #880 (sandbox trial function) merged first and kept
    `0142`; this migration renumbered to `0143` with a later journal `when` before merging.

## 2026-10-13: review round 2 fixes

- [A] After merging main (which now has #859's `0141`), the migration was initially
  `0142_tenant_lifecycle_role.sql` with journal `idx` 142. Before this it had been idx 140, then
  0143/idx 141. Later renumbered to `0143` to avoid collision with #880 (see R5 note below).
- [B] `provisionTenant`, `suspendTenant`, `reactivateTenant` and `scheduleTenantDeletion` now write
  their `admin_audit_log` entry inside `withTenantContext(tenantId, …)`, the same fix #868 made for
  the sandbox workers. On plain `db` the RLS-protected insert was rejected for `app_user` after the
  tenants write had committed, so each action returned a 500. Unit tests assert each write uses the
  tenant-context transaction; they fail on the previous code.

## 2026-10-13: review round 3 fix

- The purge worker's G5 audit entries (`purge.completed`, and `purge.failed` on the final
  attempt) were still written on plain `db`. RLS rejects that insert for `app_user`, and it
  ran after the `tenants` status flip had committed, so every retry failed the same way until the
  job ran out of attempts. Both now go through `withTenantContext(tenantId, …)`.
- `anonymizeAuditLogForTenant` stays on plain `db` on purpose. It is an UPDATE, which `app_user`
  is not granted on `admin_audit_log`, and it refuses to run under a tenant context. Follow-up:
  under the compose stack the worker connects as `app_user`, so that UPDATE needs the privileged
  connection its doc comment assumes. This is pre-existing and was scoped out by the reviewer.
- New `apps/worker/src/tenant-purge.test.ts` captures the worker's processor and failure handler,
  and asserts both G5 writes use the tenant-context transaction. They fail on the previous code.

## 2026-10-13: sandbox accounts can sign in (folded into this PR)

- Found in manual testing: a freshly provisioned sandbox's admin couldn't sign in. Zitadel
  refused with APP-asb43 ("the user is required to have at least one grant on the
  application"), because provisioning created the org and users but never granted the OpenWind
  project (owned by the main org) or any role on it.
- `packages/auth` gains `grantProjectToOrg(orgId)` (v2
  `ProjectService.CreateProjectGrant`, roles `admin`, `agent`, `user`) and
  `authorizeUser(userId, orgId, roleKeys)` (v2 `AuthorizationService.CreateAuthorization`). Both
  use the provisioning service account, take the project from `ZITADEL_PROJECT_ID` (or
  `ZITADEL_AUDIENCE`), treat "already exists" as success, and never log response bodies. Both v2
  services were confirmed present on the instance before building on them.
- The provisioning worker grants the project right after creating the org, authorizes the admin
  as `admin` and every other seeded account as `user`. A failed grant or admin authorization
  rolls the sandbox back. A member that can't be authorized counts as a failed account and is
  left out of the handover list.
- Tests: the two Zitadel calls (exact path and body, already-exists, refusal); the worker's
  order, role mapping and each failure path.
- Existing sandboxes don't get the grants retroactively; recreate them to test.
- Security review follow-up (medium, made reachable by the above): outside production,
  `extractAuthContext` puts `DEV_TENANT_ID` on every token, so on a local or dev stack a
  sandbox admin would have landed in the dev tenant (Demo Company) with admin rights. The new
  `resolveTenantIdForAuth` (used by `requireAuth` and the notifications WebSocket) prefers the
  tenant mapped from the token's Zitadel org (`tenants.zitadel_org_id`) in every environment.
  Outside production it falls back to `DEV_TENANT_ID` only for an unmapped org; production is
  unchanged (mapped, or rejected). Orgs already mapped to the dev tenant resolve as before.
- Hardening from the same review: `authorizeUser` is typed to, and checked at runtime against,
  the sandbox allowlist (`admin`, `agent`, `user`). It refuses anything else (e.g. `superadmin`,
  `platform_admin`) without calling Zitadel.
- Tests: mapped org outside production resolves to the mapped tenant; unmapped org falls back;
  the production cases are unchanged; the WebSocket registers under the resolved tenant and
  refuses an unresolved one; disallowed roles are refused.

## 2026-10-13: renumbered to 0143 after #880 merged

- #880 merged first, as agreed, and keeps `0142_platform_admin_sandbox_trial`. This migration is
  now `0143_tenant_lifecycle_role.sql` with journal `idx` 143 and the latest `when`.
- The merge of `main` made from GitHub had dropped `0142_platform_admin_sandbox_trial` from this
  branch's journal, which would have left #880's migration unrun on fresh databases. The journal
  is now main's entries plus `0143_tenant_lifecycle_role`.
- Stale "migration 0142" references updated to 0143 in the isolation test file header and
  `describe` block.
