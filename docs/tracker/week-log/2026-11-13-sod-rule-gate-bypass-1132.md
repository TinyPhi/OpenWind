# 2026-11-13 — Segregation of duties write-gate bypass fix (#1132)

## Context

Issue #1132 identified that `apps/api/src/lib/sod-rule-gate.ts` (`assertMaySetActorRules`) only inspected transition `conditions`. A non-tenant-admin workflow admin could:

1. Add an unruled transition on the same `(fromState, toState)` edge, bypassing segregation-of-duties rules.
2. Patch `allowedRoles` to bypass department gating when `conditions` was omitted from the payload.
3. Apply the same bypasses through the workflow canvas save endpoint.

## Done

- `apps/api/src/lib/sod-rule-gate.ts`:
  - Added `assertMayModifyRuledRoles`: verifies only person admins can modify `allowedRoles` on transitions that carry actor rules (order-insensitive via `sameMembers`).
  - Added `assertMayAddTransitionOnEdge`: prevents non-person-admins from creating alternate unruled transitions between states that already have an actor rule.
- `apps/api/src/routes/workflows/transitions/create-transition.ts`:
  - Pre-queries existing transitions on `(fromState, toState)` within the transaction and asserts `assertMayAddTransitionOnEdge`.
- `apps/api/src/routes/workflows/transitions/update-transition.ts`:
  - Asserts `assertMayModifyRuledRoles` whenever `input.allowedRoles` is present and the transition carries an actor rule.
- `apps/api/src/routes/workflows/canvas.ts`:
  - Enforced `assertMayModifyRuledRoles` on existing transitions with actor rules when updating roles.
  - Enforced `assertMayAddTransitionOnEdge` preventing newly added or repointed edges alongside surviving ruled transitions without breaking pre-existing duplicate edges.
- Tests:
  - Unit tests in `sod-rule-gate.test.ts` for both new guard functions and order-insensitive role set equality.
  - Integration route tests in `transitions-sod-gate.test.ts` for POST and PATCH endpoints.
  - Canvas save tests in `canvas.test.ts` for role modification, alternate edge additions, and pre-existing duplicate edge compatibility on ruled workflows.

## Verification

- `pnpm --filter api test src/`: 136 files passed, 1524 tests passed.
- `pnpm --filter api lint && pnpm --filter api typecheck`: clean (0 errors, 0 warnings).
