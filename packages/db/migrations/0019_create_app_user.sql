-- Migration: 0019_create_app_user
-- analytics: excluded (creates a DB role + grants — no table, no analytics surface)
-- Creates the app_user role used by withTenantAndUserContext.
-- app_user is a non-superuser, non-bypassrls role — all queries that must
-- be subject to RLS run under this role (set via SET LOCAL ROLE inside a
-- transaction).  Previously app_user was assumed to exist out-of-band;
-- this migration creates it idempotently so CI and fresh installs work.
--
-- DOWN MIGRATION:
-- REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_user;
-- REVOKE USAGE ON SCHEMA public FROM app_user;
-- DROP ROLE IF EXISTS app_user;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user;

-- Tenant-scoped tables — read/write for app_user.
-- These GRANTs catch up tables whose earlier migrations ran before
-- app_user was created (the conditional GRANTs in those files were skipped).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  entity_instances,
  entity_relations,
  entity_fields,
  workflow_events,
  automation_rules,
  automation_executions,
  outbox_events,
  connector_credentials,
  api_keys,
  tenant_users,
  files,
  view_configs,
  saved_views
TO app_user;

-- admin_audit_log is append-only: no UPDATE or DELETE.
GRANT SELECT, INSERT ON admin_audit_log TO app_user;

-- dead_letter_events: INSERT (workers write here), SELECT (admin reads).
GRANT SELECT, INSERT ON dead_letter_events TO app_user;

-- Read-only access to system/config tables the application layer queries.
GRANT SELECT ON entity_types, tenants, workflows, workflow_states,
  workflow_transitions, modules
TO app_user;
