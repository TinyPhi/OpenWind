# 2026-11-02 — i18n Phase 2C builder and wizard string extraction (#1096)

## Context

Phase 2C of the multi-lingual support initiative (#200) as specified in issue #1096:
Extract every remaining hardcoded English UI string from three page groups (Entity Types, Automations Wizard, Workflows) into the existing `common` i18n namespace, mirror all new keys across all 10 non-English stub locales, add missing test imports, and preserve build/performance invariants.

## Work Completed

1. **String Extraction**:
   - `pages/entity-types/detail.tsx`: Extracted table headers, field types, enum options, modal labels, and CRUD actions.
   - `pages/entity-types/instance-create.tsx`: Extracted form tabs, user/team assign modes, placeholders, error alerts, and action buttons.
   - `pages/entity-types/instance-detail.tsx`: Extracted timeline events, actor descriptions, field diffs, state transition modal, and edit forms.
   - `pages/workflows/create.tsx`: Extracted title, subtitle, name/plural/icon inputs, informational cards, and buttons.
   - `pages/workflows/detail.tsx`: Extracted ~100 remaining UI strings across canvas, tabs (Steps, Actions, Details, Settings), modals (Add/Edit Step, Action, Detail, Delete Workflow), and unsaved changes guard dialog. Renamed loop variables to prevent shadowing `t`.
   - `pages/automations/wizard/wizard.tsx`: Extracted step navigation, wizard titles, actions, and save flow.
   - `pages/automations/wizard/step-actions.tsx`: Converted static maps (`ACTION_TYPE_LABELS`, `ACTION_TYPE_DESCRIPTIONS`) to runtime getters; extracted sub-configs for notification, field update, transition, webhook, and ticket creation.
   - `pages/automations/wizard/step-conditions.tsx`: Converted operators to dynamic runtime getters and extracted condition groups/rules.
   - `pages/automations/wizard/step-trigger.tsx`: Converted trigger options to runtime getters and extracted trigger narrowing alerts and dropdowns.
   - `pages/automations/wizard/step-save.tsx`: Extracted summary labels, priorities, and status toggles.
   - `pages/automations/wizard/step-ticket-template.tsx`: Extracted ticket creation parameters, workflow dropdowns, severity options, and error states.

2. **Test File Setup**:
   - Added `import "../../i18n.js";` or `import "../../../i18n.js";` to test files rendering components with translation hooks (`entity-types/detail.test.tsx`, `automations/wizard/step-actions.test.tsx`, `step-trigger.test.tsx`, `step-ticket-template.test.tsx`).

3. **Locale Key Parity**:
   - Updated `locales/en/common.json` with all new keys under `entityTypes`, `workflows`, and `automations`.
   - Mirrored every new key with identical English placeholder value across all 10 stub locale files (`hi`, `mr`, `bn`, `ta`, `te`, `kn`, `fr`, `de`, `it`, `es`).
   - Verified 100% parity via `locale-completeness.test.ts`.

4. **Performance & Entry Size Optimization**:
   - Configured `manualChunks` in `apps/admin-ui/vite.config.ts` for `/locales/` to keep entry bundle size at 181.2 kB gzip, comfortably under the 215 kB limit.

## Verification

- `pnpm typecheck`: Passed with 0 errors.
- `pnpm lint`: Passed with 0 warnings/errors (`--max-warnings=0`).
- `pnpm test`: 110 test files and 1162 tests passed.
- `scripts/check-entry-size.mjs`: Passed (181.2 kB <= 215 kB).
