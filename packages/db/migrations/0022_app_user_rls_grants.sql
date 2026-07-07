-- Migration: 0022_app_user_rls_grants
-- Part of closing #121: withTenantContext / executeRawInTenantContext now issue
-- SET LOCAL ROLE app_user so RLS is actually enforced (previously they ran as
-- the superuser/table-owner connection, which always bypasses RLS).
--
-- DOWN MIGRATION:
-- REVOKE INSERT, UPDATE, DELETE ON entity_types, workflows, workflow_states, workflow_transitions FROM app_user;
-- REVOKE UPDATE ON tenants FROM app_user;
-- REVOKE DELETE ON dead_letter_events FROM app_user;
--
-- app_user previously had SELECT-only on entity_types, workflows,
-- workflow_states, workflow_transitions, and no grant at all on tenants
-- writes. Every route that mutates these tables already goes through
-- withTenantContext (workflow/state/transition CRUD, module install/uninstall
-- writing tenants.config.installed_modules, and module seed SQL inserting
-- entity_types/workflows/workflow_states/workflow_transitions rows via
-- executeRawInTenantContext). Switching the role without adding these grants
-- would turn all of those into permission-denied errors.
--
-- Note: entity_types and workflows have a nullable tenant_id column but no
-- RLS policy at all (system/template rows use tenant_id = NULL); workflow_states
-- and workflow_transitions have no tenant_id column (scoped via workflow_id).
-- These GRANTs do not change that — tenant isolation for these four tables
-- remains enforced solely by the explicit ownership checks in
-- packages/workflow-engine (assertWorkflowOwned / visibleTo), same as before
-- this migration. Tracked as a follow-up, not part of #121's scope.

GRANT INSERT, UPDATE, DELETE ON
  entity_types,
  workflows,
  workflow_states,
  workflow_transitions
TO app_user;

-- tenants: module install/uninstall updates config.installed_modules + updated_at.
-- Row selection (WHERE tenants.id = tenantId) is enforced at the application layer.
GRANT UPDATE ON tenants TO app_user;

-- dead_letter_events: apps/worker/src/tenant-purge.ts deletes a tenant's dead-lettered
-- job rows via withTenantContext during tenant purge. 0019 granted only SELECT, INSERT
-- (workers insert, admins read) — that DELETE would fail permission-denied without this.
GRANT DELETE ON dead_letter_events TO app_user;
