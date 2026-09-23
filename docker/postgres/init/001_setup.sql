-- docker/postgres/init/001_setup.sql
-- Runs once on first container start.
-- Creates application users, databases, and enables required extensions.

-- ─── Zitadel database ────────────────────────────────────────────────────────
CREATE DATABASE zitadel;

-- ─── Superset metadata database (reporting, track 3G) ────────────────────────
-- Superset stores its own dashboards, charts, users and roles here, and creates
-- those tables itself on first start. That needs DDL, which is why it cannot
-- live on the platform database's read-only reporting role.
--
-- Two distinct connections, deliberately not the same credential:
--   superset_user  → this database, read/write, Superset's own furniture only
--   analytics_user → the platform database, read-only, the reporting data
-- A compromise of the metadata credential therefore does not carry read access
-- to tenant data, and the reporting credential cannot alter Superset's own
-- objects.
CREATE USER superset_user WITH PASSWORD 'superset_user_dev_password';
CREATE DATABASE superset OWNER superset_user;

-- ─── Application database users ───────────────────────────────────────────
-- app_user: normal application runtime — subject to RLS, no DDL
CREATE USER app_user WITH PASSWORD 'app_user_dev_password';

-- migration_user: runs schema migrations — BYPASSRLS, DDL allowed
-- NEVER used in application runtime
CREATE USER migration_user WITH PASSWORD 'migration_user_dev_password' CREATEROLE;

-- analytics_user: read-only, the reporting credential.
-- (BYPASSRLS was removed by migration 0112 — reporting is subject to RLS.)
CREATE USER analytics_user WITH PASSWORD 'analytics_user_dev_password';

-- Let the migration runner administer this role.
--
-- Migration 0112 issues `ALTER USER analytics_user NOBYPASSRLS`, and 0118/0120/
-- 0122 issue GRANT/REVOKE against it. PostgreSQL 16 tightened CREATEROLE: it no
-- longer confers the right to alter *any* role, only roles the grantee has ADMIN
-- on. analytics_user is created here by the superuser, so without this line
-- migration_user cannot touch it and the chain stops at 0112 with
-- "Only roles with the CREATEROLE attribute and the ADMIN option on role
-- analytics_user may alter this role" — which is exactly what a from-scratch
-- `pnpm db:migrate` did before this was added.
--
-- INHERIT FALSE and SET FALSE keep this to administration only: migration_user
-- may alter the role, but does not gain its privileges and cannot SET ROLE to
-- it. Membership without either is the PostgreSQL 16 way to say "may manage,
-- may not become".
GRANT analytics_user TO migration_user WITH ADMIN OPTION, INHERIT FALSE, SET FALSE;

-- ─── Grant connect ────────────────────────────────────────────────────────
GRANT CONNECT ON DATABASE platform TO app_user;
GRANT CONNECT, CREATE ON DATABASE platform TO migration_user;
GRANT CONNECT ON DATABASE platform TO analytics_user;

-- ─── Extensions (run as superuser during init) ─────────────────────────────
\c platform

CREATE EXTENSION IF NOT EXISTS "pgcrypto";       -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";        -- trigram indexes for search
CREATE EXTENSION IF NOT EXISTS "btree_gin";      -- GIN indexes on scalar types
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"; -- query performance

-- ─── Schema setup ─────────────────────────────────────────────────────────
-- migration_user owns the schema and can alter it
ALTER SCHEMA public OWNER TO migration_user;

-- app_user gets usage + DML
GRANT USAGE ON SCHEMA public TO app_user;
GRANT USAGE ON SCHEMA public TO analytics_user;

-- Future tables: app_user gets DML, analytics_user gets SELECT
ALTER DEFAULT PRIVILEGES FOR ROLE migration_user IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

ALTER DEFAULT PRIVILEGES FOR ROLE migration_user IN SCHEMA public
  GRANT SELECT ON TABLES TO analytics_user;

ALTER DEFAULT PRIVILEGES FOR ROLE migration_user IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- ─── Row-Level Security: ensure app_user cannot bypass ───────────────────
-- migration_user can bypass RLS (needed for migrations and cross-tenant ops)
ALTER USER migration_user BYPASSRLS;
ALTER USER analytics_user BYPASSRLS;
-- app_user explicitly cannot bypass RLS (this is the default, but explicit)
-- ALTER USER app_user NOBYPASSRLS; -- this is the default

-- ─── Verification ─────────────────────────────────────────────────────────
SELECT
  rolname,
  rolsuper,
  rolbypassrls,
  rolcreaterole
FROM pg_roles
WHERE rolname IN ('platform', 'app_user', 'migration_user', 'analytics_user');
