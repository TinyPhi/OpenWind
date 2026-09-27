## 2026-09-27 — #678 automation executor honours trigger_config

**Session type:** Bug fix, automation-engine (priority raised to high, security label)
**Branch:** `fix/PLAT-678-automation-trigger-config`
**Spec:** `docs/specs/automation-trigger-config-scoping.md`

### Why it was worse than filed

#678 was found in module seeds, but the automation wizard stores all of a rule's scope (workflow,
state, entity type, field) **only** in `trigger_config`, which the executor never read. So every
wizard-built rule fired on every event of its trigger type in the tenant, including `webhook`
(outbound), `transition` and `set_field` actions.

### Done

- `packages/automation-engine/src/trigger-scope.ts`: `ruleInScope`.
  - Scope keys per trigger type: `workflowId` / `fromState` / `toState` for transitions;
    `workflowId` / `state` for SLA breaches; `entityTypeId` for entity events.
  - The legacy seed `entityType` name is compared against the event's entity type name.
  - Empty, null or `""` means any; unknown keys are ignored.
- `executor.ts`: checks the scope before conditions and before any execution row is written.
  Entity-type name lookups are memoised and tenant-filtered.
- `actions/transition.ts`: follow-up events now carry the transitioned instance's real
  `entityTypeId`.
- Operator query for rules whose matching narrows, in the spec §I.

### Verification

- Prove-it isolation tests failed before the fix:
  - `automation-trigger-config-scoping`: 5/6 failing.
  - `automation-transition-entity-type`: failing.
- Both pass after, with 9 new unit tests for `ruleInScope`. The existing automation suites run
  with `{}` configs, and `{}` still matches everything.

### Review

- **Code review (medium).** Uuid scope keys compared case-sensitively, so an uppercase id saved
  through the API would never match. Fixed: id keys (`workflowId`, `entityTypeId`) now compare
  case-insensitively, while state names stay exact. Unit test added.
- **Security pass.** No findings in the diff. It flagged one pre-existing issue: RLS is the only
  thing stopping a tenant from renaming a system-template entity type. It's filed in
  `pending-review-findings.md`, because name-scoped rules now depend on it.
- **Behaviour change to expect.** The seeded helpdesk rules (`{"entityType":"ticket"}`: default
  priority, on-call auto-assign, severity dispatch) now fire only for the `ticket` type, as
  intended. They no longer fire for other ticket-like types a tenant created. The spec's operator
  query lists the affected rules.

### Follow-up

- #684: wizard/API `trigger_config` key mismatches, and trigger types nothing emits.
