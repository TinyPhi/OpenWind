# Multi-Lingual Support — Admin UI

> Config-driven UI localisation for admin-ui: language selector in Settings, 11 target
> languages, Indic + European, English fallback. Zero backend changes in v1.

status: approved
created: 2026-10-26
updated: 2026-10-26

---

## §G Goal

- Agent/admin users can select their display language from Settings → Language.
- Preference persists per device via `localStorage` (`ow:language`).
- 11 languages ship: English (fallback), Hindi, Marathi, Bengali, Tamil, Telugu, Kannada,
  French, German, Italian, Spanish.
- Every screen label, action, and status string is translatable via a single key namespace.
- Untranslated keys silently fall back to English — partial translation is always safe to ship.
- Refine resource labels ("Dashboard", "Records", etc.) are translated alongside custom strings.
- Screen readers see the correct `document.documentElement.lang` on every language switch.

## §C Constraints

| constraint   | value                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| stack        | `i18next@^26.3.6` + `react-i18next@^17.0.11` (already installed); Vitest + jsdom for tests; Vite bundle                          |
| auth         | no change — language is a client-side UI preference only                                                                         |
| tenancy      | no DB column; no API change; no RLS implication                                                                                  |
| out of scope | backend locale storage, email/notification translation, RTL layout, professional translations, tenant-level language enforcement |
| perf budget  | ≤ 150 KB gzipped added to main bundle for all 10 non-English locale files                                                        |
| font         | Noto Sans Devanagari download gated by CSS `unicode-range` — not loaded for Latin-language users                                 |

## §I Interfaces

**`lib/language.ts` (new)**

```ts
export const SUPPORTED_LANGUAGES: readonly string[]; // 11 codes
export function getSavedLanguage(): string; // validates against SUPPORTED_LANGUAGES; falls back to "en"
export function setSavedLanguage(lng: string): void;
export function changeLocale(lng: string): Promise<void>; // validates, calls i18n.changeLanguage, sets localStorage, updates document.lang
export function useLocale(): {
  locale: string;
  changeLocale: (lng: string) => Promise<void>;
};
```

**`locales/<lng>/common.json`** — one file per language, single `common` namespace.
Key convention: `screen.element` camelCase (e.g. `login.signInButton`, `settings.language.title`).
English (`en`) is the canonical reference; all other locales mirror its key structure.

**Refine i18nProvider** (wired in `App.tsx`)

```ts
{
  translate: (key, params) => t(key, params),
  changeLocale: (lng) => changeLocale(lng),
  getLocale: () => i18n.language,
}
```

## §R Requirements

R1: Language selector in Settings
✓ Settings page has a "Language" tab (beside Appearance)
✓ Tab shows all 11 languages by native name (e.g. "हिन्दी", "Español", "English")
✓ Active language is visually indicated
✓ Selecting a language updates the UI immediately without page reload
✓ Selection persists across page reload and new browser sessions on the same device

R2: Language initialisation on app startup
✓ App reads `ow:language` from `localStorage` on load
✓ An unrecognised or missing value falls back to `"en"`
✓ `document.documentElement.lang` is set to the resolved language on startup

R3: English fallback for untranslated keys
✓ A key present in `en/common.json` but absent from another locale renders the English string
✓ No `undefined`, key string, or empty string appears in the UI for missing translations

R4: Indic font loading
✓ Noto Sans Devanagari (Hindi, Marathi) is available when those languages are active
✓ Noto Sans (Bengali, Tamil, Telugu, Kannada) is available when those languages are active
✓ Latin-language users do not download Devanagari font bytes

R5: Refine resource labels translated
✓ Refine navigation and resource labels ("Dashboard", "Analytics", "Records", etc.) use `t()` via i18nProvider
✓ Switching language updates the sidebar/nav labels without reload

R6: Locale-aware date/number formatting
✓ `analytics.tsx` and `dashboard.tsx` use `useLocale().locale` instead of the hardcoded `"en-IN"`

R7: Locale completeness gate
✓ CI fails if a key exists in `en/common.json` but is missing from any other locale stub
✓ Completeness test runs in under 200ms

R8: localStorage language code validation
✓ A value read from `localStorage` that is not in `SUPPORTED_LANGUAGES` is rejected and falls back to `"en"`
✓ `document.documentElement.lang` is never set to an unvalidated string

## §V Invariants

- `getSavedLanguage()` never returns a code outside `SUPPORTED_LANGUAGES`
- `document.documentElement.lang` is always set from a validated language code, never raw `localStorage` output
- Translation values never render via `dangerouslySetInnerHTML`; i18next interpolation outputs text only
- `fallbackLng: "en"` is never removed — partial translation must always be safe
- All 11 locale stubs contain identical top-level keys to `en/common.json` (enforced by completeness test)
- No `process.env` reads introduced; no `any` types

## §T Tasks

| id  | task                                                                                                       | phase | status | depends |
| --- | ---------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Update `i18n.ts`: add 10 languages to `resources` + `supportedLngs`                                        | 1     | todo   | —       |
| T2  | Create `src/locales/<lng>/common.json` × 10 (English copy as stub)                                         | 1     | todo   | T1      |
| T3  | New `lib/language.ts`: `getSavedLanguage`, `setSavedLanguage`, `changeLocale`, `useLocale` with validation | 1     | todo   | T1      |
| T4  | Unit tests for `lib/language.ts` (validation, localStorage, document.lang)                                 | 1     | todo   | T3      |
| T5  | New `locales/locale-completeness.test.ts`                                                                  | 1     | todo   | T2      |
| T6  | Language tab in `settings.tsx` (native names, persistence, live switch)                                    | 1     | todo   | T3      |
| T7  | Wire Refine `i18nProvider` in `App.tsx`                                                                    | 1     | todo   | T3      |
| T8  | Add Noto Sans + Noto Sans Devanagari to `index.css`                                                        | 1     | todo   | —       |
| T9  | Replace hardcoded `"en-IN"` in `analytics.tsx` + `dashboard.tsx` with `useLocale().locale`                 | 1     | todo   | T3      |
| T10 | Extract Settings + Layout strings (P2A)                                                                    | 2     | todo   | T1–T9   |
| T11 | Extract Dashboard + Records strings (P2B)                                                                  | 2     | todo   | T10     |
| T12 | Extract Entity types + Workflows + Automations strings (P2C)                                               | 2     | todo   | T10     |
| T13 | Extract Users + Teams + On-call + Schedule rules strings (P2D)                                             | 2     | todo   | T10     |
| T14 | Extract API keys + Plugins + Logs + Reporting strings (P2E)                                                | 2     | todo   | T10     |
| T15 | Extract Platform admin incl. `format.ts` relative-time strings (P2F)                                       | 2     | todo   | T10     |

phase gate: `pnpm typecheck && pnpm lint && pnpm test` green before advancing to phase 2

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
