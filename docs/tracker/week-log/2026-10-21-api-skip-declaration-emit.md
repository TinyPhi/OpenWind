# 2026-10-21 — apps/api stops emitting declarations (unblocks hono 4.13.x, Dependabot #1058)

- `apps/api/tsconfig.json`: `declaration` and `declarationMap` set to `false`. The shared base tsconfig
  turns both on; with hono 4.13.11 the build failed with 57 TS2742 errors in 43 files ("inferred type of
  `getAccessHandler` cannot be named without a reference to `hono/dist/types/context.js`") because every
  exported `factory.createHandlers(...)` handler needs a `.d.ts`.
- Safe because `@platform/api` is an app: no workspace package depends on it and it has no `types` or
  `exports` field, so nothing reads its declarations.
- Verified: `@platform/api` build and typecheck pass on main, and with hono 4.13.11 applied (Dependabot's
  package.json and lockfile changes) the api build passes and api, worker and auth typecheck pass.
- Follow-up: once this merges, Dependabot #1058 needs a rebase to pick it up. Its Security scan failure was
  not investigated.
