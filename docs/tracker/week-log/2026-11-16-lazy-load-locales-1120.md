# 2026-11-16 — Lazy-load non-English locales (#1120)

## Done

- `apps/admin-ui/src/i18n.ts`: only English is bundled eagerly; the other ten locales load through `loadLocale` (a Vite `import.meta.glob` of the locale files, excluding `en`). `i18nReady` loads the saved language before first render; a load failure falls back to English and logs.
- `apps/admin-ui/src/lib/language.ts`: `changeLocale` loads the bundle first and keeps the current language if the load fails.
- `apps/admin-ui/src/main.tsx`: renders after `i18nReady`.
- `apps/admin-ui/vite.config.ts`: the `manualChunks` rule previously put every locale into one `locales` chunk, which `index.html` preloads, and would have merged the dynamic imports back into it. It now matches `/locales/en/` only.
- `apps/admin-ui/src/i18n.test.ts`: 5 tests (English-only up front, on-demand load, idempotent, unknown and path-like input ignored, English fallback).

## Finding

The issue frames this as entry-chunk size, but the entry chunk was never the cost: the locales were a separate 806 kB raw (249.6 kB gzip) chunk preloaded on every load. Entry stays at about 181 kB gzip (budget 215 kB, unchanged). Initial load (entry plus preloads) goes 430.9 to 204.8 kB gzip, 1383 to 649 kB raw. The `check-entry-size.mjs` budget does not measure this; left as is.

## Verification

- `pnpm exec vitest run` in admin-ui: 117 files, 1295 tests pass, run with `NODE_OPTIONS=--localstorage-file=<path>`. Without it, 24+ tests in `login`, `settings`, `language` and `platform-admin-mfa-session` fail identically on unmodified main (Node experimental `localStorage` needs the flag); environment only.
- `pnpm typecheck` and `pnpm lint`: PASS.
- `pnpm test:isolation`: N/A, no API, DB or route change.
- Non-English languages are still disabled in the UI (`TRANSLATED_LANGUAGES` is `["en"]`, #1110), so the lazy path is covered by unit tests but not reachable from the UI yet.
