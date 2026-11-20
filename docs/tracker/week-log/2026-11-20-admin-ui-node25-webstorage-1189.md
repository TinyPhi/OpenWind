# 2026-11-20 — admin-ui tests pass on Node 25+ (#1189)

## Done

- `apps/admin-ui/vitest.config.ts` passes `--no-webstorage` to the test workers when the running Node major version is 25 or later. Node 25+ defines an experimental global `localStorage` that is `undefined` without `--localstorage-file` and shadows jsdom's. CI runs Node 22, which does not know the flag, so it is passed only where it exists.
- Before the change, 43 tests failed on Node 26 in four files: `login.test.tsx` (21), `language.test.ts` (18), `settings.test.tsx` (3) and `platform-admin-mfa-session.test.ts` (1). They passed 65/65 on Node 22.
- `docs/local-setup.md`: the Node version note now says `admin-ui` handles Node 25+ itself and keeps the `NODE_OPTIONS=--no-webstorage` workaround for jsdom run any other way. #758 documented the gotcha; this removes the need for the workaround in the normal test run.
- No test file added: the 43 existing tests are the regression coverage, and they failed without this change.
- `engines.node` (`>=22`) is unchanged; narrowing it would be a contract change (see #758).

## Verification

- `admin-ui` suite through turbo, `--filter=@platform/admin-ui`: Node 26.13 passes 1290/1290; Node 22.23 passes 1290/1290 (run with `--force`, so not served from cache).
- The four formerly failing files pass 65/65 on Node 26.
- A fresh worktree has no built workspace packages (`@platform/ui` points `main` at `./dist`), so run the suite through `turbo run test`, not `vitest` directly, until `pnpm build` has run.
