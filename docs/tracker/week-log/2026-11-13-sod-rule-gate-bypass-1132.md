# 2026-11-13 — Segregation of duties write-gate bypass fix (#1132)

## Context

Issue #1132 identified that `apps/api/src/lib/sod-rule-gate.ts` (`assertMaySetActorRules`) only inspected transition `conditions`. A non-tenant-admin workflow admin could:

1. Add an unruled transition on the same `(fromState, toState)` edge, bypassing segregation-of-duties rules.
2. Patch `allowedRoles` to bypass department gating when `conditions` was omitted from the payload.
3. Apply the same bypasses through the workflow canvas save endpoint.

## Done

First round (2026-11-13), superseded by the review round below where noted:

- `apps/api/src/lib/sod-rule-gate.ts`: added a same-edge duplicate guard and a ruled-transition-only role guard.
- `create-transition.ts`, `update-transition.ts`, `canvas.ts`: wired those guards to `POST`, `PATCH` and the canvas save.
- Tests: unit tests for the guards, route tests for POST and PATCH, and canvas save tests.

## Review round 1 (2026-11-20, PR #1180)

The first round only checked the exact `(fromState, toState)` pair, so a non-admin workflow admin could still route around a ruled edge through a new intermediate step, a skip edge, or by widening roles on an unruled sibling. The CHANGELOG and spec said the bypass was eliminated; it was not.

- **M1, workflow-wide gate.** `sod-rule-gate.ts` now has `workflowCarriesActorRule` and `assertMayEditRuledWorkflow`, replacing the edge guard and the ruled-transition role guard. On a workflow where any transition carries an `actor_*` rule, only a person admin may add or re-point a transition, or change `allowedRoles` or `conditions` on any transition. Used by create, update and the canvas save. Adding a step alone, labels, `requiresComment`/`requiresFields` and deleting an unruled transition stay open.
- **G1** (unruled sibling) is covered by the same gate.
- **G2.** Create and update transition check ownership first (`assertWorkflowOwned`, now exported from `@platform/workflow-engine`), so a caller who does not administer the workflow gets 404 whatever the edge state.
- **S1, S2.** The canvas gate uses the write path's own partition (`newTransitions`, known `existingTransitions`) and builds the prior-transition map and deleted-id set once.
- **Docs.** CHANGELOG and spec §K state exactly what is enforced and keep the real remaining limits (concurrent edit, seed and plugin paths, self-loops, pre-existing admin-authored unruled paths).
- **Tests.** Route tests for the two-hop detour, skip edge, unruled sibling (roles and conditions), API-key admin, non-owner 404, and ordinary workflows staying open; canvas tests for the detour in one save, skip edge, sibling roles, re-pointing an existing unruled transition, API-key admin, a stale id that no longer yields a misleading 403, and ordinary workflows; and a real-Postgres test (`apps/api/tests/isolation/workflow-sod-gate.isolation.test.ts`) showing the rule lookup is per workflow, the 404-first behaviour, and that a refused canvas save leaves the graph untouched. Against the old code, five of the new canvas tests and three of the six database tests fail.
- **Security review of the fixes found two more bypasses of the same class on routes the first pass had not touched; both are reproduced and fixed.**
  - `PATCH /workflows/:id` accepted `initialState` with no SoD check, so a non-admin workflow admin could move the initial step past a ruled edge and every new record would skip the rule. Now admin-only on a ruled workflow, with ownership checked first.
  - A canvas save deleted a step a rule names (with its unruled edges), because it skipped the engine's `assertStateNotNamedByRule` that the standalone delete route runs. The canvas now calls the same guard (exported from `@platform/workflow-engine`).
  - Tests for both are in the real-database file; both fail without the fix.
  - Left as is: DELETE of a ruled transition or workflow answers 403, not 404, to a caller who does not administer it. Informational, since definitions are tenant-readable.
- **Behaviour change.** Non-admin workflow admins can no longer edit roles or conditions on any transition, or add or re-point transitions, on a workflow that carries an actor rule.

## Verification

See the PR body.
