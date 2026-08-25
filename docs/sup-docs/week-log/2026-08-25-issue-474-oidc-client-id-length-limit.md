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
