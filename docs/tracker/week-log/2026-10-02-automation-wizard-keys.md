# 2026-10-02 — automation wizard and API config keys aligned (#684 part 1)

**Session type:** Bug fix
**Branch:** `fix/684-automation-trigger-keys`

- **Trigger keys:**
  - The wizard now writes `toState` for "State entered" and `field` for "Field changed",
    the keys the API validates.
  - "Field changed" requires both an entity type and a field before the wizard advances. The
    "any field" option is gone until #684 part 2 maps it onto `entity.updated`.
- **Empty strings:**
  - Placeholder options remove their key instead of sending `""`.
  - The API strips `""` from `triggerConfig` on create and update, so a placeholder no longer
    fails the uuid check or gets stored.
- **SLA breached:** the API schema now validates `state`, which the executor already reads.
- **Actions with the same drift:**
  - `set_field` now writes `field`. Before, every wizard-built set-field action failed with 400.
  - Webhook headers are saved as a `{name: value}` record, and loaded back into rows when
    editing.
- **Split out:** the transition action sends a free-text name where `transitionId` is needed,
  which needs a picker. Filed as #760.
- **Tests:**
  - `admin-ui`: new `payload.test.ts`, plus a `canAdvance` case.
  - `api`: new `trigger-config.test.ts`. Its 4 SLA-state and empty-string tests fail on the old
    API code.
