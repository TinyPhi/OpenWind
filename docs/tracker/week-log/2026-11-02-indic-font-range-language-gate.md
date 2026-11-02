# 2026-11-02 — Indic font delivery and language selector gate (#1110, #1092)

## Context

Follow-up to multi-lingual support Phase 1 (#200) addressing language gating and font delivery:

1. #1110: All 11 locales were selectable in the Settings Language tab even though non-English locales are stubs.
2. #1092: Investigation of Indic web font loading and verification of Google Fonts on-demand unicode-range delivery.

## Done

- `apps/admin-ui/src/index.css`:
  - Restored Google Fonts `@import` including Noto Sans Indic font families (`Devanagari`, `Bengali`, `Kannada`, `Tamil`, `Telugu`) which natively emit per-script `@font-face` blocks with `unicode-range` descriptors for on-demand downloads.
  - Added dedicated CSS styles for `.language-list`, `.language-option`, `.language-option-active`, `.language-option-disabled`, `.language-option-name`, and `.language-option-badge`.
- `apps/admin-ui/src/lib/language-storage.ts` & `language.ts`:
  - Added `TRANSLATED_LANGUAGES = ["en"] as const satisfies readonly SupportedLanguage[]`.
  - Added `isTranslatedLanguage(lng)` type guard helper to eliminate repeated type assertions.
  - Enforced `TRANSLATED_LANGUAGES` validation in `getSavedLanguage()` and `changeLocale()`. Unsaved or un-translated locales silently fall back to `"en"`.
- `apps/admin-ui/src/pages/settings.tsx`:
  - Gated language options against `TRANSLATED_LANGUAGES`.
  - Marked untranslated options as `disabled` with `aria-disabled="true"` and a localized "Coming soon" badge.
- `apps/admin-ui/src/locales/*/common.json`:
  - Added `settings.comingSoon: "Coming soon"` across all 11 locale files.
- `apps/admin-ui/src/locales/locale-completeness.test.ts`:
  - Added key-by-key comparison ensuring enabled locales in `TRANSLATED_LANGUAGES` provide at least 80% translated values.
  - Added tests asserting untranslated stub locales currently have < 5% differing values from English.
- Tests & Infra:
  - Added `apps/admin-ui/src/lib/i18n-provider.ts` and `apps/admin-ui/src/lib/i18n-provider.test.ts` (4 unit tests).
  - Added `apps/admin-ui/src/pages/settings.test.tsx` (3 unit tests, including asserting `changeLocale` is not invoked on disabled options).
  - Extended `apps/admin-ui/src/lib/language.test.ts` (18 unit tests validating locale fallback and persistence behavior).

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: admin-ui (all tests PASS)
- Entry size: within gzip budget (< 215 kB)
