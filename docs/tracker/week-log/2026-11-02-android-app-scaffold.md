## 2026-11-02 — Android app: scaffold `apps/android/`

### Done

- Created `apps/android/` with an engineer onboarding README and a `.gitignore`, so the Kotlin app can
  be imported from a local machine into the repo. The folder has no `package.json`, so pnpm and Turbo
  ignore it and no existing check is affected.
- The README covers the import steps, the target Gradle module layout, running against the local
  stack (emulator `10.0.2.2` and the Zitadel issuer-match caveat), platform rules (tenancy, OIDC
  PKCE, config-first, no secrets) and PR rules.
- Listed the open items in the README: mobile ADR (human-authored), OpenAPI spec and Kotlin client,
  push (device tokens + FCM), Android CI workflow, Zitadel native-app client.

### Verification

- pnpm typecheck: N/A — docs-only
- pnpm lint: N/A — docs-only
- pnpm test: N/A — docs-only
- pnpm test:isolation: N/A — docs-only

### Next

- Engineer imports the app into `apps/android/` in a follow-up PR.
- A maintainer adds the path-filtered Android CI workflow (`.github/workflows/` is maintainer-only).
- Human writes the mobile ADR; add a tracker row once it exists.

### Open questions

- None.
