# 2026-10-16 — Connector definition lookup (#960)

**Session type:** Review follow-up
**Branch:** `fix/PLAT-hardening-connector-definition-lookup`
**Issue:** #960 (R2 finding on #936)

- **Done.** `connectorDefinitionExists(connectorId)` in `@platform/db` (`connector-credentials.ts`) does one
  `WHERE id = $1 LIMIT 1` lookup. `scripts/connector-credential-set.ts` calls it instead of selecting every row of
  `connector_definitions` and comparing in memory.
- **Decision.** The issue offered adding `drizzle-orm` to the root or a raw `sql` query. Neither is needed:
  `@platform/db` already hosts `connectorInstallationFilter` for the same reason (scripts/ has no drizzle
  operators, and another copy's operators don't typecheck against this package's column types), so the helper
  lives there. No dependency or lockfile change.
- **Verified.** Isolation test on real Postgres (`connector-definition-exists.isolation.test.ts`): true for a
  definition it inserts, false for an unknown uuid, false after the definition is deleted; it failed before the
  helper existed. The unused `db` destructure in the script was removed.
- **Deferred.** The helper requires a UUID (Postgres rejects anything else on a uuid column); the CLI already
  validates `--connector` as a UUID first. The test shows the lookup is correct, not that it avoids a table scan.
