# 2026-10-20 — Entity create remark warning & SoD teardown referential integrity (#1022, #1025)

**Session type:** Implementation  
**Branch:** `fix/api-create-warning-and-sod-teardown`  
**Issues:** #1022, #1025

- **Done (#1022).**
  - Aligned `POST /entities` with the contract introduced for child tickets in #1007: when `postRemarkComment` fails after the entity is created, the response returns `201` with `warnings: ["remark_comment_failed"]` (and omits `warnings` when successful).
  - Updated `apps/admin-ui/src/pages/customer/record-create.tsx` to detect `warnings` and forward notice state to the record detail page navigation.
  - Updated `apps/admin-ui/src/pages/customer/record-detail.tsx` to display and dismiss the record notice banner when present in `location.state`.
  - Added unit test coverage in `apps/api/src/routes/entities/create.test.ts`.

- **Done (#1025).**
  - Fixed referential integrity violation (`workflow_events_workflow_id_workflows_id_fk`) in `apps/api/tests/isolation/segregation-of-duties.isolation.test.ts`.
  - Replaced partial in-memory `instanceIds` deletion with tenant-scoped cleanup across both test tenants (`[TENANT, OTHER_TENANT]`), removing all `workflowEvents`, `entityInstances`, `workflowTransitions`, `workflowStates`, and `workflows` in correct dependency order.
  - Wrapped `workflowEvents` deletion in `withEventLogMaintenanceContext` with direct fallback to comply with migration 0147 event log protection.
  - Added pre-flight cleanup in `beforeAll` so stale state from prior interrupted runs is wiped before test setup begins.

- **Verification.**
  - `pnpm --filter @platform/api test src/routes/entities/create.test.ts` (all 26 tests pass).
  - `pnpm --filter @platform/api test:isolation tests/isolation/segregation-of-duties.isolation.test.ts` (all 24 tests pass, clean exit).
  - `pnpm --filter @platform/api typecheck` (clean).
  - `pnpm --filter @platform/api lint` (clean).
  - `pnpm --filter @platform/admin-ui typecheck` (clean).
  - `pnpm --filter @platform/admin-ui lint` (clean).
