-- Migration: 0107_schedule_sweeper_role
-- analytics: excluded (creates a DB role + grants — no table, no analytics surface)
--
-- Fixes a bug found during manual QA of the temporal scheduler (3F): the poll
-- in schedule-tick-worker.ts's schedulerTick/claimRule deliberately queries
-- `schedule_rules` *across all tenants* in one pass (there is no single
-- tenant to scope app.tenant_id to — same situation 0064_outbox_sweeper_role
-- solved for outbox_events). But schedule_rules has RLS (see
-- 0101_schedule_rules_table.sql's `tenant_id = current_setting('app.tenant_id',
-- true)` policy), and the worker's runtime DB role (app_user) is NOBYPASSRLS
-- — so every poll ran with no app.tenant_id GUC set, which RLS evaluates as
-- `tenant_id = NULL`, matching zero rows. Every schedule rule on every tenant
-- has silently never fired since the feature shipped (migration 0101).
-- schedule-tick-worker.ts's own header comment already claimed it followed
-- "the same convention as sla-scheduler.ts's cross-tenant outbox sweep" —
-- the SET LOCAL ROLE call to actually opt into that convention was simply
-- never added.
--
-- Fix: a dedicated BYPASSRLS role, table-scoped to schedule_rules only
-- (SELECT/UPDATE — no INSERT/DELETE, matching outbox_sweeper's shape), that
-- schedule-tick-worker.ts's schedulerTick and claimRule opt into via
-- `SET LOCAL ROLE` before querying schedule_rules cross-tenant. app_user
-- itself stays NOBYPASSRLS, so ordinary tenant-scoped queries are unaffected.
--
-- DOWN MIGRATION:
-- REVOKE SELECT, UPDATE ON schedule_rules FROM schedule_sweeper;
-- REVOKE schedule_sweeper FROM app_user;
-- DROP ROLE IF EXISTS schedule_sweeper;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'schedule_sweeper') THEN
    CREATE ROLE schedule_sweeper NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;

GRANT schedule_sweeper TO app_user;

GRANT USAGE ON SCHEMA public TO schedule_sweeper;
GRANT SELECT, UPDATE ON schedule_rules TO schedule_sweeper;
