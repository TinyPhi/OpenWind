# 2026-10-27 — Multi-lingual support Phase 1 implementation (#200)

## Done

- T1: `apps/admin-ui/src/i18n.ts` — registered 11 language resources (en, hi, mr, bn, ta, te, kn, fr, de, it, es) with `getSavedLanguage()` for initial language selection
- T2: 10 locale stub files (`src/locales/<lng>/common.json`) — exact copy of English 52-key baseline; ready for string extraction in Phase 2
- T3: `apps/admin-ui/src/lib/language.ts` — `SUPPORTED_LANGUAGES` allowlist, `getSavedLanguage` (validates localStorage), `setSavedLanguage`, `changeLocale` (validates before setting `document.documentElement.lang`), `useLocale` hook
- T4: `apps/admin-ui/src/lib/language.test.ts` — 11 unit tests covering empty localStorage, valid codes, injection attempts, document.lang guard
- T5: `apps/admin-ui/src/locales/locale-completeness.test.ts` — 10 completeness tests via `import.meta.glob`; CI-gated key-parity check for all non-English locales
- T6: `apps/admin-ui/src/pages/settings.tsx` — Language tab with 11 languages by native name; available to all users (not admin-only); `aria-selected` + checkmark for active selection
- T7: `apps/admin-ui/src/App.tsx` — Refine `i18nProvider` wired (`translate`, `changeLocale`, `getLocale`)
- T8: `apps/admin-ui/src/index.css` — Google Fonts `@import` extended to include Noto Sans + Noto Sans Devanagari; `--font-sans` updated; broken `local()`-only `@font-face` blocks removed after code review (Google Fonts handles Noto subsetting natively)
- T9: `apps/admin-ui/src/pages/analytics.tsx` + `dashboard.tsx` — `useLocale().locale` replaces hardcoded `"en-IN"` in date-formatting helpers
- CHANGELOG.md — Phase 1 entry added

## Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: PASS (1084/1084)
- pnpm test:isolation: N/A — no new tables or routes
- security-review: PASS (no findings)
- code-review: 1 real finding fixed (broken @font-face), 2 false positives rejected

## Track

- Multi-lingual support (spec-driven, outside track table) — Phase 1 complete
- Phase 2 (string extraction T10–T15) tracked in issues #1094–#1099

## Open questions

None — Phase 1 is self-contained. Phase 2 can begin when Phase 1 PR merges.
