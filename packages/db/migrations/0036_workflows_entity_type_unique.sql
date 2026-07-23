-- Down migration:
-- DROP INDEX IF EXISTS workflows_tenant_entity_type_unique;

-- Closes issue #168: nothing previously stopped a second workflow row from
-- being created against an entity_type_id another workflow already governs
-- within the same tenant — createWorkflow was an unconditional INSERT, and
-- getWorkflowByEntityTypeId (which authorizes listing + field mutations)
-- resolved ties with an unordered SELECT ... LIMIT 1. The codebase already
-- assumes a 1:1 tenant+entity_type -> workflow relationship everywhere
-- (entityTypeId can never be changed after creation — see
-- UpdateWorkflowInput in packages/workflow-engine/src/types.ts), this just
-- makes that assumption a real DB guarantee. See ADR-006 Known gap #3 and
-- docs/specs/workflow-ownership-admin.md.
--
-- No partial-index predicate needed: every workflow created through the
-- application today has a real (non-NULL) tenant_id (system-template,
-- NULL-tenant workflows are a schema-level allowance with no seed data or
-- code path that creates one). If that changes in the future, this
-- constraint's NULL-tenant behavior (standard SQL: multiple NULLs are not
-- considered duplicates) will need revisiting alongside that work.
CREATE UNIQUE INDEX IF NOT EXISTS workflows_tenant_entity_type_unique
  ON workflows (tenant_id, entity_type_id);
