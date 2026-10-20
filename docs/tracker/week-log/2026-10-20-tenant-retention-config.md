# 2026-10-20 — configurable per-tenant retention policy updates (#637)

- Added per-tenant retention policy update endpoint: `PATCH /admin/tenants/:id/retention`.
- Centralized retention bounds and validation in `@platform/config`:
  - `RETENTION_BOUNDS`: `noiseDays` (7–3650, default 90), `commentDays` (30–3650, default 90), `evidenceDays` (365–7300, default 2555).
  - `TenantRetentionConfigSchema` and `UpdateTenantRetentionSchema` ensuring at least one retention field is provided.
  - `resolveRetentionPolicy` to safely extract and fallback retention parameters from tenant JSONB config.
- Refactored `apps/api/src/lib/tenant-lifecycle.ts` and `apps/worker/src/retention-policy.ts` to consume centralized bounds from `@platform/config`.
- Security & Guards:
  - Route guarded by `requireAuth(db)`, `requireRole("superadmin")`, `requireIntrospection()` (live Zitadel introspection preventing stolen-JWT attacks), and `denyUnlessPlatformOperator` (returns 404 for non-platform tenants to prevent existence discovery).
  - Accidental data loss protection: shortening any retention window (`retention_days`, `retention_comment_days`, `retention_evidence_days`) below the current resolved policy requires `confirmShorten: true`, otherwise rejecting with 400 `CONFIRM_SHORTEN_REQUIRED`.
  - Updates merged into `tenants.config` JSONB non-destructively, preserving other config keys such as `rate_limit_per_min`.
  - Executed inside `withTenantContext` so `writeAuditEntry` satisfies PostgreSQL RLS on `admin_audit_log` with before and after snapshots.
- Tests:
  - `@platform/config`: 7 unit tests in `retention.test.ts`.
  - `@platform/worker`: verified 6 unit tests in `retention-policy.test.ts`.
  - `@platform/api`: comprehensive unit tests in `src/routes/admin/tenants.test.ts` (25 tests) covering platform operator fence, schema bounds, shortening confirmation guard, widening, legal hold toggling, non-retention config preservation, and audit log entries.
  - `@platform/api`: added isolation test suite `tests/isolation/tenant-retention.isolation.test.ts` covering role gates, platform fence, database persistence, and audit logging under real PostgreSQL.
