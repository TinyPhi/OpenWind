## 2026-08-21 — Issue #451: length limit on api_keys.zitadel_client_id

**Session type:** Bug fix / defense-in-depth hardening
**Branch:** `chore/PLAT-451-zitadel-client-id-length-limit` (stacked on the still-open PR #452's
branch, `chore/PLAT-445-...`, to avoid a migration-number collision — same precedent as PR
A1→A2 in this same feature)

### Completed this session

#### Issue #451 (zitadel_client_id had the same DB-unbounded-but-Zod-bounded gap #445 fixed for three sibling columns)

- Migration `0071_api_keys_zitadel_client_id_length_limit.sql` (renumbered from 0070 during a
  later rebase — main's tip claimed 0069/0070 first via PR #446/PR #452, same shape as #445's
  own 0069→0070 renumber): `CHECK (char_length(zitadel_client_id) <= 200)`, matching
  `create.ts`'s existing Zod `.max(200)` bound. Audited `platform_test` first (zero rows with
  any `zitadel_client_id` populated) before applying, per migration 0037/0070's established
  precedent.
- `create.ts`'s existing `23514`→`422` mapping (added in #445) generalized from
  `constraint_name.startsWith("api_keys_application_")` to `.endsWith("_length")` — covers all
  four length-bound columns by naming convention instead of hardcoding each one; verified no
  other constraint on the table ends in `_length` (including the pre-existing
  `api_keys_scopes_format_check`, explicitly tested to _not_ be misrouted through this branch).
  Renamed `ApplicationMetadataTooLongError` → `FieldTooLongError` to match the broadened scope.
- Extended the existing table-driven test (`api-key-application-metadata-length.test.ts`) with
  a fourth `BOUNDED_COLUMNS` entry rather than a new file — same real-Postgres CHECK-constraint
  proof, now covering all four columns.
- Added a unit test for the `23514`→422 mapping itself — this branch (added in #445) had no
  dedicated unit test before now, a pre-existing gap this ticket closed incidentally.

### Review notes

`/review` ran several rounds across many parallel finder agents (line-by-line, cross-file trace,
removed-behavior audit, reuse, simplification, efficiency, altitude, conventions). Real,
actioned findings:

- Test's random-suffix generator (`Math.random().toString(36)`, variable length) replaced with
  `crypto.randomUUID()` (fixed-length, stronger collision resistance) — the column also carries
  a partial unique index, so a weak generator risked flaky collisions.
- Test teardown's sequential per-row deletes replaced with one batched `inArray(...)` delete,
  matching the pattern the very next line already used for the tenant row.
- Duplicated `cause instanceof Error && "code" in cause && ...` boilerplate across the two
  constraint-error branches in `create.ts` narrowed to one shared check.

Findings considered and explicitly **not** acted on:

- Folding migration 0070 into 0069 (they land in the same session) — not done, since 0069
  belongs to the still-open, already-in-review PR #452; retroactively editing its content now
  would invalidate an in-progress human review of that PR. Two small migrations in exchange for
  not disturbing an in-flight review is the right trade here.
- Routing `ClientIdInUseError`/`FieldTooLongError` through the shared `error-handler.ts`
  machinery (`WORKFLOW_STATUS`-style) instead of a route-local catch — `ClientIdInUseError`
  already established this route-local pattern in #445/PR #452; relitigating that architecture
  choice is out of scope for a narrow follow-up ticket.
- A registry-based (vs. naming-convention-based) constraint-name match — the "silent
  misroute if a future constraint doesn't follow the naming convention" concern is real but
  low-severity: confirmed the global error handler's fallback already returns a safe generic
  500 with no detail leak (security.md rule 5), so the actual risk is a wrong error code, not
  an information disclosure.
- Shared constants for the 200/2000/320 bounds now duplicated across Zod schema, SQL migration
  comments, and this test file — pre-existing pattern since #445 (not newly introduced), a
  reprepo-wide follow-up, not blocking this diff.

Filed one genuine, unrelated finding as a follow-up rather than fixing it here: #457 —
`rotate.ts` silently drops a third-party key's application metadata (including
`zitadelClientId`) on rotation, pre-existing behavior from PR #440.

**Note:** the org hit its monthly Claude API spend limit partway through this review — two
finder agents failed mid-run. Proceeded with the substantial findings already gathered from the
completed agents plus direct manual verification, rather than re-running the fanned-out review.

### Verification

- `pnpm typecheck`: PASS
- `pnpm lint`: PASS
- Migration applied cleanly against real Postgres 16 (`platform_test`); verified the constraint
  exists via `\d api_keys`
- `api-key-application-metadata-length.test.ts` (40 assertions across both files): PASS
- Existing `api-key-client-id-uniqueness`/`api-key-mint-client-id-reclaim` isolation tests
  (9 tests): PASS — confirms the create.ts error-handling refactor didn't regress the
  pre-existing 409 Client-ID-conflict path
