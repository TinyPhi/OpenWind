## 2026-08-25 — Issue #474: Migration 0075 for `api_keys.oidc_client_id` length limit

**Session type:** Bug fix / infra
**Branch:** `fix/PLAT-0474-oidc-client-id-length-limit`

### Completed this session

#### Issue #474 Fix

- Root cause: Migration `0071` (`api_keys_zitadel_client_id_length_limit`) added a `CHECK (char_length(zitadel_client_id) <= 200)` constraint on `zitadel_client_id`. Subsequent migration `0072` renamed `zitadel_client_id` to `oidc_client_id`. Because 0071 had an older journal timestamp (`1785542423000`) compared to 0072's timestamp (`1787414412147`), 0071 was skipped on databases where 0072 was applied before 0071. Moreover, attempting to run 0071 against a post-rename DB failed with `column "zitadel_client_id" does not exist`.
- Added forward migration `0075_api_keys_oidc_client_id_length_limit.sql`:
  - If `api_keys_zitadel_client_id_length` exists (from environments where 0071 ran prior to column rename), it renames the constraint to `api_keys_oidc_client_id_length`.
  - If neither constraint exists (from environments where 0071 was skipped), it adds `api_keys_oidc_client_id_length CHECK (char_length(oidc_client_id) <= 200)`.
  - If `api_keys_oidc_client_id_length` already exists, it safely no-ops.
- Registered migration `0075` in `packages/db/migrations/meta/_journal.json` with timestamp `1787552479620`.
- Updated `apps/api/tests/integration/api-key-application-metadata-length.test.ts` to document and cover migration `0075`.

### Verification

- `pnpm db:migrate` applied migration 0075 cleanly.
- `apps/api/tests/integration/api-key-application-metadata-length.test.ts` passed (9/9 tests passed).

#### PR #479 review response (PrabhuVijit, changes-requested)

- Rollback comment in `0075` was incomplete/destructive for State-A (rename-branch)
  databases — a blind `DROP CONSTRAINT` would leave the column with no length check at
  all on a rollback. Rewrote it to document both branches and how to tell them apart
  (whether 0071's timestamp is in `__drizzle_migrations`).
- Added two integration tests exercising `0075`'s Branch 1 (RENAME — the path every
  pre-existing State-A database actually takes, the scenario that motivated this fix in
  the first place) and Branch 3 (no-op) by re-executing the shipped migration file's own
  SQL against simulated pre-migration states, not a re-implementation of its logic.
- Added a schema-drift comment on `oidcClientId` in `platform.ts` (matching the existing
  pattern on `category`) documenting the DB-only 200-char CHECK invisible to Drizzle.
- Qualified the `pg_constraint` guards' `::regclass` casts with `public.` explicitly, so
  they don't depend on the connection's `search_path`.

### Verification (review-response round)

- `pnpm typecheck`: PASS
- `pnpm lint`: PASS
- `pnpm test`: PASS (142/142 files, 1104/1104 tests, `@platform/api`)
- `apps/api/tests/integration/api-key-application-metadata-length.test.ts`: PASS, 11/11,
  ×3 consecutive runs — includes the two new branch tests
- Manually confirmed final constraint state on `platform_test`: only
  `api_keys_oidc_client_id_length` present after the rename-branch test ran (no leftover
  old-named constraint)
