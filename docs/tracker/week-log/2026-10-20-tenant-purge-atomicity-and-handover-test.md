# 2026-10-20 — tenant-purge atomicity and handover test coverage

**Session type:** Reliability hardening & test coverage  
**Spec:** `docs/specs/multi-org-sandbox.md` R8/R9 (delete/purge), T14, T21  
**Branch:** `fix/tenant-purge-atomicity-and-handover-test`  
**Issues closed:** #931 (`make tenant-purge pre-steps and audit anonymisation atomic`), #930 (`add mixed per-account/missing-password handover test`)

- **Context.**
  - Issue #931 was flagged in PR #928 R1 review: in `apps/worker/src/tenant-purge.ts`, privileged pre-steps (`schedule_rules` archive, `schedule_executions` delete, `saved_views` delete) ran in a first `withTenantPurgeContext` call, and `anonymizeAuditLogForTenant` ran in a second, separate call. If the second call failed (e.g. transient Postgres connection error), the pre-steps remained committed, leaving the tenant in a half-purged state where schedule/views data was wiped but personal identifiers in `admin_audit_log` persisted.
  - Issue #930 was flagged in PR #926 R1 review: `getSandboxHandoverCredentials` returns `null` when any account lacks a password and no record-level `defaultPassword` is present. Existing tests covered all accounts having passwords, all accounts falling back to `defaultPassword`, and completely missing passwords, but lacked test coverage for a mixed scenario (some accounts with passwords, some without).

- **Changes made.**
  - **Atomic tenant-purge (#931):** Merged the two `withTenantPurgeContext` calls in `apps/worker/src/tenant-purge.ts` into a single atomic transaction block. Since `anonymizeAuditLogForTenant` accepts `DbOrTx`, both the schedule/views pre-steps and the audit anonymization now execute inside the exact same transaction under `tenant_purge_role`. If audit anonymization throws, PostgreSQL issues an atomic rollback of both operations, allowing BullMQ's automatic retry mechanism to cleanly re-attempt the entire phase without orphaned partial state.
  - **Worker unit test (#931):** Updated `apps/worker/src/tenant-purge.test.ts` to assert that `mockWithTenantPurgeContext` is called exactly once (`toHaveBeenCalledTimes(1)`), verifying both pre-steps and audit anonymization occur inside that single atomic transaction context.
  - **Mixed handover test (#930):** Added a unit test in `packages/auth/src/sandbox-handover-store.test.ts` asserting that `getSandboxHandoverCredentials` returns `null` for a handover record containing two accounts where one account has a password, the other lacks a password, and `defaultPassword` is absent. This locks in the fail-closed security invariant against future refactors.

- **RLS & Security Invariants.**
  - `tenant_purge_role` (migration 0144) is `NOLOGIN`, `NOBYPASSRLS`, granted to `app_user WITH INHERIT FALSE`.
  - Transaction-local role assumption (`SET LOCAL ROLE tenant_purge_role`) and tenant scoping (`SELECT set_config('app.tenant_id', ...)`) are applied once for the unified transaction and automatically revert on commit or rollback.
  - Audit log table column-level privileges remain strictly limited to the anonymizable person fields (`actor_id`, `acting_person_id`, `metadata`, `before_snapshot`, `after_snapshot`), preserving operational history integrity.

- **Verification.**
  - Worker unit tests: `pnpm --filter @platform/worker test --pool=threads tenant-purge.test.ts` (passed).
  - Auth unit tests: `pnpm --filter @platform/auth test --pool=threads sandbox-handover-store.test.ts` (passed).
  - Typecheck & Lint: `@platform/worker` and `@platform/auth` pass.
