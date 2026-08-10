-- Migration: 0053_outbox_sweeper_role
-- analytics: excluded (creates a DB role + grants — no table, no analytics surface)
--
-- Fixes a production outage: 0050_outbox_events_rls.sql enabled RLS on
-- outbox_events/dead_letter_events with a policy that casts
-- current_setting('app.tenant_id', true) to uuid. outbox-poller.ts and
-- notification-poller.ts both deliberately sweep outbox_events *across all
-- tenants* in one query (they can't set app.tenant_id — there is no single
-- tenant to scope to), and the runtime DB role (app_user, see
-- 0019_create_app_user.sql) is NOBYPASSRLS, so every sweep since 0050
-- shipped has failed with `invalid input syntax for type uuid: ""` and
-- silently dropped every outbox event platform-wide (automation triggers
-- and in-app/email notifications alike — see #125's notify pipeline).
--
-- Fix: a dedicated BYPASSRLS role, table-scoped to outbox_events only
-- (SELECT/UPDATE — no INSERT/DELETE), that the three cross-tenant sweep
-- transactions opt into via `SET LOCAL ROLE` (outbox-poller.ts,
-- notification-poller.ts, sla-scheduler.ts). app_user itself stays
-- NOBYPASSRLS, so ordinary tenant-scoped queries are unaffected by default.
--
-- Caveat: Postgres enforces no restriction on *who* runs `SET LOCAL ROLE
-- outbox_sweeper` — app_user is granted membership because it's the
-- platform's single runtime DB role (apps/api and apps/worker both connect
-- as app_user, per docker-compose.yml), so this grant is necessarily
-- available on every app_user connection, not just the three sweep call
-- sites. The real boundary is code discipline (no other code path issues
-- this SET ROLE) plus "no raw SQL string-built from user input"
-- (security.md #3), not a DB-enforced one. If app_user is ever split into
-- per-service roles, narrow this grant to only the worker's role.
--
-- DOWN MIGRATION:
-- REVOKE SELECT, UPDATE ON outbox_events FROM outbox_sweeper;
-- REVOKE outbox_sweeper FROM app_user;
-- DROP ROLE IF EXISTS outbox_sweeper;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outbox_sweeper') THEN
    CREATE ROLE outbox_sweeper NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;

GRANT outbox_sweeper TO app_user;

GRANT USAGE ON SCHEMA public TO outbox_sweeper;
GRANT SELECT, UPDATE ON outbox_events TO outbox_sweeper;
