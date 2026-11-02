# 2026-11-02 — Indic font unicode-range (#1092) and language selector gate (#1110)

## Context

Follow-up to multi-lingual support Phase 1 (#200) addressing two gaps:

1. #1092: Indic font subsets downloaded for Latin users due to missing `unicode-range` CSS blocks.
2. #1110: All 11 locales were selectable in the Settings Language tab even though non-English locales are stubs.

## Done

- `apps/admin-ui/src/index.css`:
  - Scoped Google Fonts `@import` to Latin and common fonts (`Inter`, `Outfit`, `Noto Sans`).
  - Added `@font-face` blocks with `font-display: swap` and `unicode-range` descriptors for Devanagari (Hindi/Marathi), Bengali, Tamil, Telugu, and Kannada (~35 lines CSS).
  - Added `.language-list`, `.language-option`, `.language-option-active`, `.language-option-disabled`, and `.language-option-badge` styles.
- `apps/admin-ui/src/lib/language-storage.ts` & `language.ts`:
  - Added `TRANSLATED_LANGUAGES = ["en"] as const`.
  - Enforced `TRANSLATED_LANGUAGES` validation in `getSavedLanguage()` and `changeLocale()`.
- `apps/admin-ui/src/pages/settings.tsx`:
  - Gated language options against `TRANSLATED_LANGUAGES`.
  - Marked untranslated options as `disabled` with `aria-disabled="true"` and a localized "Coming soon" badge.
- `apps/admin-ui/src/locales/*/common.json`:
  - Added `settings.comingSoon: "Coming soon"` across all 11 locale files.
- `apps/admin-ui/src/locales/locale-completeness.test.ts`:
  - Added check verifying enabled non-English locales in `TRANSLATED_LANGUAGES` have actual translations differing from English.
- Tests & Infra:
  - Added `apps/admin-ui/src/lib/i18n-provider.ts` and `apps/admin-ui/src/lib/i18n-provider.test.ts` (4 unit tests).
  - Added `apps/admin-ui/src/pages/settings.test.tsx` (3 unit tests).
  - Extended `apps/admin-ui/src/lib/language.test.ts` (18 unit tests, including localStorage script injection security guards).

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: admin-ui (1160+ tests PASS)
- Entry size: 194.3 kB gzip (budget: 215 kB)
- Security review: validated language codes prevent DOM attribute / XSS injection on `document.documentElement.lang`.
