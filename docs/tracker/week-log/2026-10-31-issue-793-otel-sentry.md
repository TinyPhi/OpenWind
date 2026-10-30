## 2026-10-31 — 3D: OTel 1.x copies cleared (#793)

### Done

- Bumped `@sentry/node` ^8.20 to ^10.78 in `packages/telemetry` (v10 is the first line on OTel 2.x;
  v9 still pins OTel 1.x). v10.78 no longer bundles the DB instrumentations.
- Removed the unused direct dependency `@opentelemetry/sdk-metrics ^1.30` (no imports anywhere);
  it was the second source of `@opentelemetry/core` 1.30.1.
- `pnpm why` now shows one copy each of `@opentelemetry/core` (2.10.0) and
  `@opentelemetry/instrumentation-pg` (0.73.0). `pnpm audit` reports no OpenTelemetry or Sentry
  advisories (before: GHSA-8988-4f7v-96qf on core 1.30.1 and GHSA-qqmp-wf37-98f9 on pg, mysql,
  mysql2, knex, mongoose and tedious, seven audit entries, not the "10" in the issue title).
- `Sentry.init` now sets `sendDefaultPii: false` explicitly and leaves every tracing/profiling
  option unset; `errors.test.ts` asserts both.
- Removed the OTel bullet from the Deferred block in `pnpm-workspace.yaml` (resolved).

### Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: telemetry 37/37 PASS; worker/api/admin-ui DB and chunk failures are pre-existing
- pnpm test:isolation: same 13 worker failures as main (local DB drift)

### Open questions

- Not run: smoke against a real GlitchTip/Bugsink backend (merge gate), docker observability stack.
- ADR-015 still names the Sentry 8 SDK; a human should update it.
- Sentry v10 still sets up its own OTel provider next to NodeSDK (unchanged from v8); consider
  `skipOpenTelemetrySetup` in a follow-up.
