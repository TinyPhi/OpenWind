import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import common from "./locales/en/common.json";
import commonHi from "./locales/hi/common.json";
import commonMr from "./locales/mr/common.json";
import commonBn from "./locales/bn/common.json";
import commonTa from "./locales/ta/common.json";
import commonTe from "./locales/te/common.json";
import commonKn from "./locales/kn/common.json";
import commonFr from "./locales/fr/common.json";
import commonDe from "./locales/de/common.json";
import commonIt from "./locales/it/common.json";
import commonEs from "./locales/es/common.json";
import { getSavedLanguage } from "./lib/language.js";

/**
 * i18n scaffolding (PLAT-200, proof of concept)
 * ================================================================
 *
 * This wires up `react-i18next` for the admin-ui app. It is deliberately a
 * PARTIAL conversion — see GitHub issue #200. Only `pages/login.tsx` and
 * `pages/callback.tsx` have been fully extracted so far, to prove the pattern
 * works end to end. The other ~55 files with hardcoded English strings are
 * intentionally untouched and are follow-up work.
 *
 * Extraction pattern for whoever picks up the remaining files:
 *
 * 1. Key naming convention: one top-level namespace per screen/feature,
 *    named after the page/component (e.g. `login`, `authCallback`,
 *    `settings`, `dashboard`). Nest related strings under that namespace
 *    (e.g. `login.theme.switchToLight`). Keep keys camelCase and descriptive
 *    of the string's ROLE, not its English content (`signInButton`, not
 *    `signInWithZitadel`) — this way the key stays stable if the copy
 *    changes later.
 *
 * 2. Locale files live at `src/locales/<lng>/common.json`, one flat JSON
 *    tree per language, loaded as a single `common` namespace (default
 *    i18next namespace). We are not splitting into multiple namespaces
 *    per file at this scale — one file per language is enough for the
 *    current string volume. Revisit only if `common.json` becomes
 *    unwieldy (many hundreds of keys).
 *
 * 3. In a component: `import { useTranslation } from "react-i18next";`
 *    then `const { t } = useTranslation();` and replace each literal with
 *    `t("namespace.key")`. For strings that appear in JSX text content,
 *    attributes (`aria-label`, `title`, `alt`), or are passed to functions
 *    (e.g. toast/error messages) — all of these should be extracted, not
 *    just visible body text.
 *
 * 4. When you fully convert a screen, add every one of its hardcoded
 *    strings to `common.json` under that screen's namespace in the SAME
 *    pass — do not leave a screen half-converted (mixed `t()` calls and
 *    literals). This mirrors the PLAT-200 POC scope: pick a screen, convert
 *    it completely, move to the next one.
 *
 * 5. Adding a new language later: create `src/locales/<lng>/common.json`
 *    with the same key shape as `en/common.json`, then add it to the
 *    `resources` map below and to `supportedLngs`. A language switcher UI
 *    is NOT part of this scaffold — `i18next-browser-languagedetector` (or
 *    a simple user-preference field) is the natural place to plug one in
 *    when that becomes a real requirement.
 */
void i18n.use(initReactI18next).init({
  resources: {
    en: { common },
    hi: { common: commonHi },
    mr: { common: commonMr },
    bn: { common: commonBn },
    ta: { common: commonTa },
    te: { common: commonTe },
    kn: { common: commonKn },
    fr: { common: commonFr },
    de: { common: commonDe },
    it: { common: commonIt },
    es: { common: commonEs },
  },
  lng: getSavedLanguage(),
  fallbackLng: "en",
  supportedLngs: [
    "en",
    "hi",
    "mr",
    "bn",
    "ta",
    "te",
    "kn",
    "fr",
    "de",
    "it",
    "es",
  ],
  defaultNS: "common",
  ns: ["common"],
  interpolation: {
    escapeValue: false, // React already escapes output
  },
  returnNull: false,
});

export { i18n };
