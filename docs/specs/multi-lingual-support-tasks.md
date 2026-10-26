# Implementation Plan: Multi-Lingual Support — Admin UI

**Spec:** docs/specs/multi-lingual-support.md
**Generated:** 2026-10-26
**Status:** not started
**Branch:** feat/PLAT-200-multi-lingual-support

---

## Phase 1 — Infrastructure

**Goal:** All plumbing in place; language selector works; UI falls back to English for
every untranslated key; Indic fonts load on demand; CI completeness gate active.

**Gate:** `pnpm typecheck && pnpm lint && pnpm test` green → then Phase 2

| task                                                                                                        | requirement | files touched                                            | status |
| ----------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------- | ------ |
| T1: Update `i18n.ts` (add 10 languages to `resources` + `supportedLngs`)                                    | R2, R3      | `apps/admin-ui/src/i18n.ts`                              | todo   |
| T2: Create 10 locale stubs (`src/locales/<lng>/common.json`)                                                | R3, R7      | 10 new JSON files                                        | todo   |
| T3: New `lib/language.ts` (validation, `getSavedLanguage`, `setSavedLanguage`, `changeLocale`, `useLocale`) | R1, R2, R8  | `apps/admin-ui/src/lib/language.ts`                      | todo   |
| T4: Unit tests — `lib/language.test.ts`                                                                     | R2, R8      | `apps/admin-ui/src/lib/language.test.ts`                 | todo   |
| T5: Translation completeness test — `locales/locale-completeness.test.ts`                                   | R7          | `apps/admin-ui/src/locales/locale-completeness.test.ts`  | todo   |
| T6: Language tab in `settings.tsx` (native names, active indicator, persistence)                            | R1          | `apps/admin-ui/src/pages/settings.tsx`                   | todo   |
| T7: Wire Refine `i18nProvider` in `App.tsx`                                                                 | R5          | `apps/admin-ui/src/App.tsx`                              | todo   |
| T8: Add Noto fonts to `index.css` (unicode-range blocks)                                                    | R4          | `apps/admin-ui/src/index.css`                            | todo   |
| T9: Replace `"en-IN"` with `useLocale().locale` in analytics + dashboard                                    | R6          | `apps/admin-ui/src/pages/analytics.tsx`, `dashboard.tsx` | todo   |

---

## Phase 2 — String Extraction (per screen)

**Goal:** Every visible string is driven through `t()`. Stubs mean each sub-phase is independently
safe to merge — nothing can break because `fallbackLng: "en"` covers missing keys.

**Gate:** `pnpm typecheck && pnpm lint && pnpm test` green after each sub-phase

### P2A — Settings + Layout

| task                                          | requirements | files                                                           | status |
| --------------------------------------------- | ------------ | --------------------------------------------------------------- | ------ |
| T10: Extract settings.tsx + layout/nav labels | R3           | `settings.tsx`, `components/layout.tsx`, nav items in `App.tsx` | todo   |

### P2B — Dashboard + Records

| task                                                           | requirements | files                                   | status |
| -------------------------------------------------------------- | ------------ | --------------------------------------- | ------ |
| T11: Extract dashboard.tsx + entity instance list/detail views | R3           | `pages/dashboard.tsx`, `pages/records/` | todo   |

### P2C — Entity types + Workflows + Automations

| task                            | requirements | files                                                           | status |
| ------------------------------- | ------------ | --------------------------------------------------------------- | ------ |
| T12: Extract builder UI strings | R3           | `pages/entity-types/`, `pages/workflows/`, `pages/automations/` | todo   |

### P2D — Users + Teams + On-call + Schedule rules

| task                                        | requirements | files                                                                    | status |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------ | ------ |
| T13: Extract people + scheduling UI strings | R3           | `pages/users/`, `pages/teams/`, `pages/oncall/`, `pages/schedule-rules/` | todo   |

### P2E — API keys + Plugins + Logs + Reporting

| task                                               | requirements | files                                                                  | status |
| -------------------------------------------------- | ------------ | ---------------------------------------------------------------------- | ------ |
| T14: Extract remaining platform feature UI strings | R3           | `pages/api-keys/`, `pages/plugins/`, `pages/logs/`, `pages/reporting/` | todo   |

### P2F — Platform admin

| task                                                                                                               | requirements | files                                                     | status |
| ------------------------------------------------------------------------------------------------------------------ | ------------ | --------------------------------------------------------- | ------ |
| T15: Extract platform admin strings incl. `format.ts` relative-time (`"just now"`, `"Today"`, `"Yesterday"`, etc.) | R3           | `pages/platform-admin/`, `pages/platform-admin/format.ts` | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code session to begin Phase 1:

```
Read docs/specs/multi-lingual-support.md and docs/specs/multi-lingual-support-tasks.md.

Implement Phase 1 tasks only (T1–T9). Work on branch feat/PLAT-200-multi-lingual-support.

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- T3 (lib/language.ts) must validate every language code against SUPPORTED_LANGUAGES before
  calling i18n.changeLanguage() or setting document.documentElement.lang — this is an invariant
- T5 (completeness test) must fail if any key in en/common.json is absent from any other locale stub
- T8 (fonts): use unicode-range CSS blocks so Noto Sans Devanagari only downloads for hi/mr users
- After each task run: pnpm typecheck && pnpm lint && pnpm test
- If a test fails, log it in docs/specs/multi-lingual-support.md §B before fixing
- If a bug class could recur, promote it to §V
```
