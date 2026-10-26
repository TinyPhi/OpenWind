# ADR-024 DRAFT: Multi-Lingual UI — i18next + Client-Side Language Preference

> **DRAFT — human review required before placing in docs/decisions/**
> Per project convention, ADR files in docs/decisions/ are human-authored.
> Review this draft, amend as needed, then commit it as docs/decisions/ADR-024-multi-lingual-ui.md.

**Status:** Proposed
**Date:** 2026-10-26
**Deciders:** PrabhuVijit (vijit@jmv.co.in), approved 2026-10-26
**Related to:** Issue #200, docs/specs/multi-lingual-support.md
**Supersedes:** —
**Superseded by:** —

---

## Context

### Problem

Admin-ui is English-only. The OpenWind customer base includes tenants whose agents and admins
primarily work in Hindi, Bengali, Tamil, Telugu, Marathi, Kannada, French, German, Italian, or
Spanish. All UI strings are hardcoded in TSX — no mechanism exists for alternate languages.

### Constraints that shaped the decision

- `i18next@^26.3.6` and `react-i18next@^17.0.11` are already installed (they were added
  early in the project but never fully wired).
- This is a UI preference only — tenants do not have a uniform language; individual agents
  choose their own.
- No new API routes or DB schema changes are appropriate for v1 (scope: client-side only).
- All 11 target languages are LTR — no bidirectional layout complexity.
- Two existing pages (`analytics.tsx`, `dashboard.tsx`) hardcode `"en-IN"` locale strings.
- The existing Refine `<Refine>` component accepts an `i18nProvider` slot that has not yet
  been wired.

---

## Decision

### Decision 1 — i18next as the translation engine, single `common` namespace

The already-installed `i18next` library is used with a single `common` namespace
(`src/locales/<lng>/common.json`). This keeps key lookup simple (`t("screen.element")`),
avoids namespace-routing complexity at the current key count (~300–500 keys when fully
extracted), and is reversible — namespace splitting can be added later without breaking callers.

**Not chosen:** Separate namespaces per feature area. The overhead of configuring and routing
namespaces is not justified until the key count makes single-file load time a measurable concern.

### Decision 2 — `localStorage` persistence, no backend column

Language preference is stored as `ow:language` in `localStorage`. It is a per-device UI
preference — a personal setting, not a tenant setting — and does not warrant a DB column or
API round-trip in v1.

This follows the existing pattern for `ow:theme` and `ow:accent` in `lib/theme.ts`.

**Not chosen:** `users` table `locale` column. Adds migration, API surface, and a loading
state on startup. Can be added in v2 if cross-device sync becomes a requirement.

### Decision 3 — `fallbackLng: "en"`, all locale files bundled at build time

All locale JSON files are bundled via Vite static imports, not fetched lazily. At the target
key count, 10 non-English locale files add ~80–150 KB gzipped to the main bundle — acceptable.
`fallbackLng: "en"` ensures that partial extraction (shipping before all strings are translated)
is always safe: untranslated keys render English, never `undefined` or the raw key string.

If the bundle size threshold (`scripts/check-entry-size.mjs`, currently 680 KB uncompressed) is
breached after Phase 2 extraction, the correct remediation is `i18next-resources-to-backend` to
lazy-load non-English locales on first language switch. English remains bundled in all cases.

**Not chosen:** Lazy-load from the start. Adds async loading state, a spinner, and edge-case
failure handling for a marginal (at current scale) bundle saving.

### Decision 4 — Validate language codes from `localStorage` before use

`localStorage` is writable by any script running on the origin (e.g. a prior XSS). The value
read from `ow:language` is validated against `SUPPORTED_LANGUAGES` in `lib/language.ts` before
being passed to `i18n.changeLanguage()` or `document.documentElement.lang`. An unrecognised
value silently falls back to `"en"`.

This is an invariant recorded in the spec (§V).

### Decision 5 — Indic fonts via Google Fonts with CSS `unicode-range`

Inter (Latin) is already loaded from Google Fonts. Noto Sans Devanagari (Hindi, Marathi) and
Noto Sans (Bengali, Tamil, Telugu, Kannada) are added to the same `@import` in `index.css`.

CSS `unicode-range` descriptors are used so that font files are only downloaded by the browser
when the corresponding Unicode characters are present in the rendered DOM. Latin-language users
never download Devanagari font bytes (~1.5 MB). No CSP changes are required (same origins).

### Decision 6 — Refine `i18nProvider` wired in Phase 1

Refine's navigation labels ("Dashboard", "Analytics", "Records", etc.) are hardcoded English
strings in the `resources` array in `App.tsx`. The Refine `i18nProvider` slot (`translate`,
`changeLocale`, `getLocale`) is wired in Phase 1 using the same `i18n` instance. This avoids
a split where the main UI translates but the sidebar stays English.

---

## Consequences

**Positive:**

- Language switch is instantaneous (no reload, no network round-trip).
- Partial translation is always safe to merge.
- No new API surface, no new DB tables, no RLS implications.
- Completeness test enforces parity between language stubs at CI time.

**Negative:**

- Bundle grows by ~80–150 KB gzipped once Phase 2 extraction is complete (accept; monitor).
- Professional translations must be commissioned separately — stubs ship as English copies.
- Language preference is device-specific; users switching devices see English until they
  reselect (accept for v1; v2 may add backend sync).

---

## Out of scope (this ADR)

- Email, notification, and PDF content translation
- Tenant-level language enforcement
- RTL layout
- Backend locale storage
- Professional translation tooling / vendor process

---

## Open questions for the human reviewer

- **ADR number**: confirm this is ADR-024 (last filed was ADR-023).
- **Deciders**: fill in the actual sign-off names/dates.
- **Phase gate**: confirm Phase 2 extraction phasing order (P2A–P2F) or adjust.
