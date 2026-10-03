# 2026-10-02 — inert automation trigger types retired (#684 part 2)

**Session type:** Bug fix + API contract cleanup (owner-approved: strict configs, disable rather than delete)
**Branch:** `fix/684-inert-trigger-types`

- **Executor:** `entity.updated` rules can be scoped to one field with `trigger_config.field`,
  matched against the event's `changed` map (`trigger-scope.ts`).
- **API:**
  - `workflow.entered_state`, `field.changed`, `schedule.cron` and `connector.event` now
    return 400 naming the replacement.
  - `triggerConfig` rejects unknown keys. The allow-list mirrors the executor's scope keys
    plus `entityType`.
  - Rules stored with a retired type can't be re-enabled (422).
- **Wizard:** "State entered" / "Field changed" save as `workflow.transitioned` + `toState` /
  `entity.updated` + `field`, and map back on edit. "Any field" is back.
- **List page:** labels `entity.updated` rules, marks retired ones "Trigger not supported" and
  disables their toggle.
- **Migration 0132 (data only):** converts stored `entered_state` / `field.changed` rules and
  disables `schedule.cron` / `connector.event` rules. It must merge after #759 (0131).
- **Tests:**
  - New `retired-trigger-types.test.ts` (API), `trigger-display.test.ts`, executor
    field-scope tests, and wizard mapping tests.
  - New `automation-retired-triggers.isolation.test.ts`: the migration runs per tenant and is
    a no-op on a second run, and a converted rule fires through the real executor only on its
    field.
- **Docs:** `architecture-brief.md` trigger table, `.claude/context/automation-engine.md`, and
  the spec (§B6). ADR-004 still uses `field.changed` as an example. Left for a human, since
  ADRs are human-authored.
