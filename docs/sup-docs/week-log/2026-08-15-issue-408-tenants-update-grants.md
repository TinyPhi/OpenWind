## 2026-08-15 — Issue #408 tenants UPDATE privilege column-scoping

**Session type:** Security, Bug Fixes & Code Quality
**Branch:** `fix/PLAT-408-tenants-update-grants`

### Completed this session

#### Issue #408 (tenants UPDATE privilege column-scoping)

- Created migration `0062_tenants_column_scoped_update.sql` to restrict database-level UPDATE privileges on the `tenants` table for the `app_user` role.
- Revoked the default-privileges table-level `UPDATE` permission from `app_user` on the `tenants` table.
- Re-granted column-scoped `UPDATE` permissions on the `config` and `updated_at` columns of the `tenants` table to `app_user`, matching the documented security posture in migration `0022`.
- Registered migration `0062` in `packages/db/migrations/meta/_journal.json`.
- Added tenant isolation tests in `apps/api/tests/isolation/global-catalogs-write-restrictions.isolation.test.ts` to verify that `app_user` UPDATE queries on restricted columns (like `plan`) fail with Postgres error `42501` (permission denied), while UPDATE queries on `config` succeed.
