# 2026-10-03 — automation wizard picks a transition instead of typing a name (#760)

**Session type:** Bug fix (admin-ui only). The owner chose the UX: block with a prompt when no
workflow is known, and show role-restricted transitions disabled with the reason.
**Branch:** `fix/760-wizard-transition-picker`

- **Bug:** the Transition action saved a free-text `transitionName`. The API requires
  `transitionId`, so every wizard-built transition action failed with 400.
- **Picker:** lists the transitions of the trigger's workflow, either from `workflowId` or
  found through `entityTypeId` (`GET /workflows?entityTypeId=`), and saves `transitionId`.
  Options read "Label (from → to)".
- **Next is blocked** when:
  - the trigger pins no workflow or record type ("Choose a workflow or record type on the
    Trigger step…");
  - the chosen transition isn't in that workflow, for example after the trigger changed;
  - the transition requires a comment and none is entered.
- **Role-restricted transitions** are listed disabled with "Restricted to … — automations
  can't run it". The executor passes no actor roles, so the engine would reject them.
- **Code:** `transition-action.ts` (pure rules), `use-trigger-transitions.ts` (fetch, keyed
  by workflow so a changed trigger never shows the old list), `step-actions.tsx`, and
  `canAdvance` in `wizard.tsx`.
- **Tests:** `transition-action.test.ts`, `step-actions.test.tsx`,
  `use-trigger-transitions.test.tsx`, plus two `canAdvance` cases. Eight of the new tests
  fail against the old wizard code.
- **Docs:** `docs/specs/automation-trigger-config-scoping.md` §B7.
