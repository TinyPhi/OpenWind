# 2026-10-02 — misuse-alerts test re-run fix and local DB test docs (#757, #758)

**Session type:** Test reliability + docs
**Branch:** `fix/757-758-test-cleanup-local-setup`

- #757: `third-party-misuse-alerts.isolation.test.ts` now clears its own `outbox_events` rows
  (both test tenants) in `beforeAll` and `afterAll`. `outbox_events.tenant_id` has no FK to
  `tenants`, so deleting the tenants used to leave the `system.error` alert rows behind, and the
  next run counted them. Proven on one database: before the fix, run 1 passed 3/3 and run 2
  failed 3/3. After the fix, two more runs on that same dirty database both passed 3/3. Test-only.
- #758: `docs/local-setup.md` gains "Running DB-backed tests locally". It covers:
  - why the default vitest `DATABASE_URL` fails against the compose database (CI credentials)
  - the fresh-database and migrate recipe
  - using a second fresh database for `test:isolation` after `pnpm test`
  - Node 22, or `NODE_OPTIONS=--no-webstorage` on Node 25 and later
  - dropping throwaway databases afterwards
