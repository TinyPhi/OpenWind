# 2026-09-30 — org-directory Phase 2 (T5, T6, T9)

PR4 (stacked on PR711/712/713), branch `feat/org-directory-04-sync-triggers-and-query-api`.

## Done

- T6: query API (`packages/org-directory/src/query.ts`) — `getOrgTree`, `getChainToRoot`,
  `getReportsByLevel` (grouped by level, not flat), `getSyncStatus`. Reads
  `org_employees`/`org_directory_sync_runs` only — never calls the auth provider.
- T5: sync triggers —
  - `apps/worker/src/org-directory-sync-scheduler.ts`: hourly reconcile tick, per-tenant
    first-boot auto-seed (no prior sync) and 24h staleness re-sync, mirroring
    `connector-poll-scheduler.ts`'s overlap-guarded ticker shape.
  - `apps/api/src/routes/org-directory.ts`: `GET /org-directory/tree`, `/chain/:userId`,
    `/reports/:userId`, `/sync-status` (any authenticated tenant user); `POST /org-directory/sync`
    (admin-only, audited on success, `already_running` returned as a normal 200).
- T9: isolation coverage — `apps/api/tests/isolation/org-directory-query.isolation.test.ts`
  (query API cross-tenant reads against real Postgres) alongside unit tests for the new
  route and worker scheduler.

## Verification

- pnpm typecheck: PASS (`@platform/org-directory`, `@platform/worker`, `api`)
- pnpm lint: PASS (`@platform/worker`, `api`, `--max-warnings=0`)
- pnpm test: PASS (`@platform/org-directory` 19/19; new route + scheduler unit tests green)
- pnpm test:isolation: not run this session (no live Postgres) — new isolation file is
  typecheck/lint-clean but unexecuted; needs `docker compose up -d`.

## Next

- Phase 3 (T7 admin-ui org chart page, T10 `/security-review` pass) once this PR is up and,
  ideally, PrabhuVijit has had a chance to review PR711/712/713's fix rounds.
