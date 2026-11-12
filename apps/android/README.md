# OpenWind Android app

Native Kotlin (Jetpack Compose) client for the OpenWind platform. It is meant to behave like the
web app (`apps/admin-ui`) for the core agent and customer flows, against the same API
(`apps/api`).

This folder is **outside the JS toolchain on purpose**: it has no `package.json`, so pnpm and
Turbo ignore it, and `pnpm typecheck` / `lint` / `test` / `dep:check` do not touch it. The Android
build runs on Gradle only.

> **Status:** scaffold. This README is the onboarding guide for moving the app in from your local
> machine. Nothing else lives here yet.

---

## Importing the existing app

1. **Branch off `main`** (never stack PRs). Branch naming per
   [git conventions](../../.claude/rules/git-conventions.md), e.g. `feat/PLAT-NNN-android-app-import`.
2. **Copy the project in, without history or local files.** Copy the Gradle project root into this
   folder so that `settings.gradle.kts` sits at `apps/android/settings.gradle.kts`. Do not copy
   `.git/`, `.gradle/`, `build/`, `local.properties`, `.idea/`, keystores or any `.env`. The
   [`.gitignore`](.gitignore) here covers these, but check `git status` before staging.
3. **Make sure the Gradle wrapper is included:** `gradlew`, `gradlew.bat`, and
   `gradle/wrapper/gradle-wrapper.{jar,properties}`. Builds must work with `./gradlew` and no
   globally installed Gradle.
4. **Scrub secrets before the first commit.** Search the tree for API keys, tokens, signing
   passwords, Firebase configs and hard-coded URLs. Anything secret goes to
   `local.properties` / environment (git-ignored) and CI secrets. This repo is public AGPL-3.0:
   anything committed is published, and history is not rewritten once pushed.
5. **Check dependency licenses.** Every dependency must be compatible with AGPL-3.0. Flag anything
   proprietary or with an unclear license in the PR description.
6. **Verify a clean build from a fresh checkout:**
   ```bash
   cd apps/android
   ./gradlew clean assembleDebug testDebugUnitTest lint
   ```
7. **Keep the import as one reviewable commit** (e.g.
   `feat(android): import initial app`), then add this folder's docs/config changes in a separate
   commit. Do not mix the import with refactors.
8. Open a PR. See "PR and repo rules" below.

## Layout (target)

Reorganize toward this once the import is in. It does not have to happen in the first PR.

```
apps/android/
  settings.gradle.kts
  build.gradle.kts
  gradle.properties
  gradle/libs.versions.toml       # version catalog: all dependency versions live here
  gradle/wrapper/
  app/                            # entry point, DI, navigation
  core/{network,auth,data,ui,common}/
  feature/{tickets,approvals,notifications,...}/
```

Prefer one Gradle module per feature, and no feature-to-feature dependencies. Features depend on
`core/*` only.

## Running against a local backend

The backend is the standard Docker stack. See [docs/local-setup.md](../../docs/local-setup.md) to
bring it up (`docker compose up -d`, plus Zitadel from `../zitadel/`).

- On the Android emulator, the host machine is `10.0.2.2`, not `localhost`. Use that for the API
  base URL in debug builds.
- The API base URL and the Zitadel issuer/client ID are build-time config
  (`BuildConfig` fields fed from `local.properties` or Gradle properties). Do not hard-code them.
- The OIDC issuer must match the JWT `iss` claim exactly (see `ZITADEL_ISSUER` in
  `docs/local-setup.md`). An emulator reaching Zitadel at `10.0.2.2` will not match an issuer
  configured as `localhost`, so you may need a hostname both sides resolve. Raise this early if
  login fails with an issuer mismatch.

## Platform rules that apply to the app

- **Tenancy.** Every request is tenant-scoped through the user's token. The app never sends or
  trusts a client-supplied tenant ID for authorization.
- **Auth.** OIDC Authorization Code with PKCE against Zitadel, using a native-app client. Tokens go
  in Android Keystore-backed encrypted storage. Never log tokens or PII.
- **Config-first.** The web app renders generic views from entity, workflow and field metadata, so
  new modules need no UI code. The app should follow the same approach for core flows rather than
  hand-building a screen per module. Anything that does not fit natively (workflow/automation
  builders, Superset reports, plugin slots) can open the web app in a WebView.
- **API contract.** The app consumes the same routes as the web client. If the app needs an API
  change, that is a platform change: open an issue and make it in `apps/api` with tests. Do not
  work around the API in the app.
- **No secrets in the repo,** including debug keystores' passwords, Firebase service accounts and
  Play upload keys. Release signing happens in CI with secrets stored there.

## PR and repo rules

- Follow [CONTRIBUTING.md](../../CONTRIBUTING.md) (CLA, license) and the
  [git conventions](../../.claude/rules/git-conventions.md). Commit messages use Conventional
  Commits with scope `android`, e.g. `feat(android): add ticket list screen`.
- No `Co-Authored-By` or tool-attribution lines in commits or PR bodies.
- **CI guardrails.** The "Contribution guardrails" check only looks at `.ts`/`.tsx` files, so
  Kotlin changes do not trigger the tests-with-code rule. Write unit tests (`src/test`) and
  instrumented tests (`src/androidTest`) for your code anyway.
- **Existing CI does not build this folder yet.** An Android workflow (JDK + SDK, `./gradlew lint
test assembleDebug`, path-filtered to `apps/android/**`) is to be added by a maintainer, since
  `.github/workflows/` changes need maintainer review. Until then, run the Gradle checks locally
  and paste the results in the PR.
- The `.claude/` delivery hooks gate edits under `apps/`; if you use Claude Code in this repo,
  see [.claude/README.md](../../.claude/README.md).
- Update `docs/tracker/roadmap-tracker.md` and add a dated `docs/tracker/week-log/` entry for
  meaningful changes.

## Open items (owner: platform lead)

- ADR for mobile architecture (human-authored): separate native app vs shared code, auth flow,
  push delivery (FCM), hybrid WebView scope.
- OpenAPI spec generated from the API's Zod schemas, plus a generated Kotlin client.
- Push: device-token table (RLS + isolation tests) and a hook into the notification worker
  (ADR-014).
- Android CI workflow and Play Store internal-track release pipeline.
- Zitadel native-app client (redirect URI / App Links) registered by the bootstrap.
