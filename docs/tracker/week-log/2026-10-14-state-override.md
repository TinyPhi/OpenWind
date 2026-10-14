# 2026-10-14 — guarded state override (hardening PR 2a)

**Session type:** Code
**Branch:** `feat/PLAT-hardening-state-override` (stacked on `feat/PLAT-hardening-sod-condition-operators`, #937)

- Adds the one sanctioned way to move a record outside its workflow's transitions: `overrideWorkflowState` and `POST /entities/:id/override-state`. Spec: `docs/specs/state-override.md`. Admin-only, off by default per workflow (`allow_state_override`, migration 0146, only a tenant admin can change it and the change is audited), a 10-1000 character reason, a real different target step, never the record's creator, never an API-key, system or empty identity.
- Refactor behind it: `executeTransition`'s lock and write halves are now shared `lockInstance` and `commitStateChange`, used by both transitions and the override, so the two cannot drift. The 130 engine unit tests and the existing real-Postgres workflow suites pass unchanged.
- The override writes an event that is a real state change (so it counts as acting for `actor_not_prior_actor`: an admin who overrode a step cannot then approve it), the outbox event with `override: true` (the automation schema accepts the new optional field), and moves SLA timers exactly like a transition. The route writes the `workflow.state_overridden` admin audit entry in the same transaction; the engine cannot, because it may not depend on `@platform/audit`.
- 18 real-Postgres tests run as `app_user`, mutation-checked: ignoring the switch, letting the creator override, dropping the admin requirement and dropping the SLA cancel each fail the tests meant to catch them.
- Assumptions I made where the owner's recommendations left a choice: admin-only (not a separate permission), the creator may not override, and the target may be any step including out of a terminal one.
- Not in this PR (2b): refusing the other ways of changing a workflow record's state and the admin-ui switch and dialog.
