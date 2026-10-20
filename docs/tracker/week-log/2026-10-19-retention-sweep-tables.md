# 2026-10-19 — retention sweep extended to operational tables (#636, 3D)

- Added `notification_recipients`, `notifications`, `connector_delivery_attempts`,
  `dead_letter_events` and `idempotency_keys` to `apps/worker/src/retention-sweep.ts`, using the
  existing noise window (`retention_days`, default 90). No new config knobs.
- `idempotency_keys`: the only candidate table (ADR-012 Phase G); aged by `expires_at`, so the
  window runs from expiry.
- `app_user` already has DELETE on all five tables; no migration.
- `schedule_executions` deliberately not swept: append-only, needs a `GRANT DELETE` migration and an
  ADR-017 amendment by a human.
- Issue #636 is assigned to another maintainer; picked up on the owner's instruction.
- Tests: new unit file, extended `retention-sweep.isolation.test.ts`.
- Docs: `docs/specs/retention-classes.md` item 7.
