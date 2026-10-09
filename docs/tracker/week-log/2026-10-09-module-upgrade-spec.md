# 2026-10-09 — module upgrade workflow spec (#673)

**Session type:** Spec
**Branch:** `docs/PLAT-673-module-upgrade-workflow-spec`
**Spec:** `docs/specs/module-upgrade-workflow.md` (draft)

- Interviewed the owner on scope, trigger, constraints, verification, edge cases and priority.
  Decisions: delta-based versioned upgrade files (`modules/<slug>/upgrades/<version>/`, SQL only),
  automatic sweep plus operator CLI, new RLS table `tenant_module_versions`, additive scope
  (fields, rules, new view-config rows).
- Independent review by Opus 5.5 returned BLOCKED. All five top findings were re-checked against the
  code before acting: session advisory lock vs PgBouncer transaction pooling (#752), per-call
  transactions in `executeRawInTenantContext`, ADR-022's sandbox-only platform-admin scope, and no
  unique keys on `workflow_states` / `workflow_transitions`.
- Spec revised: transaction-scoped row lock, a single-transaction `@platform/db` primitive,
  CLI-only v1 (HTTP blocked on a human ADR-022 amendment), workflow states/transitions deferred,
  baseline fixtures and the history catch-up moved into P0, CI guard moved into P0.
- Needs a human before implementation: ADR-004 follow-up accepting CF-03 and CF-04 (T0), and the
  O3 decision on unique keys for states/transitions.
