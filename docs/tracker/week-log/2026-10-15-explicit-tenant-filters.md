# 2026-10-15 — explicit tenant filters on remaining workflow-table queries

**Session type:** Hardening follow-up
**Branch:** `fix/PLAT-944-explicit-tenant-filters`
**Issue:** #944

- **Done.** Added the explicit tenant filter (security.md rule 1) to the `workflow_states` lookups and the
  `workflows` initial-state lookup in `packages/entity-engine/src/engine.ts` (`resolveInitialState` now takes
  `tenantId`), the `workflows` read in `routes/entities/get.ts`, the `workflows` rename in `module-service.ts`
  and the `workflow_transitions` read in `sandbox-module-data-seed.ts`. `workflows` reads use the
  visible-to-tenant form (own or shared), the write uses strict equality.
- **Left alone on purpose.** `deleteEntityType`'s instance count in `entity-types.ts`. For a shared
  (tenant-less) type the unfiltered count is the safer guard; a filtered count would hide other tenants'
  instances and let the delete run into the foreign key. Not exploitable under RLS either way.
- **Behaviour.** Unchanged under `withTenantContext`; existing tests pass.
