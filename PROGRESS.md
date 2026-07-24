## 2026-07-24 — Nit-bug batch #182–#185 (chore/PLAT-182-nit-bugs-batch)

### Done

- Branch cut from PR #181's tip (`1225964d`, already fully caught up with `main` at the
  time — verified via `git merge-base --is-ancestor origin/main
  origin/feat/PLAT-136-rls-workflow-config-tables`), per explicit user decision to keep
  it separate from PR #181 (RLS work, still in review) rather than commit onto it.
- **#182** — `apps/worker/package.json`: bumped `"hono"` from `^4.5.0` to `^4.12.25` to
  match the `pnpm-workspace.yaml` override (`>=4.12.25`). The explanatory comment lives
  in `pnpm-workspace.yaml` (plain JSON can't hold one), above the `hono:` override line.
- **#183** — `.claude/hooks/lib/context.js`: one-line comment added at the
  `git rev-parse --show-toplevel` delegation inside `repoRootFromAnchor`. Note: the
  issue's own description was slightly off — the function never stats `.git` itself; it
  walks to the nearest existing ancestor dir and lets the `git` binary resolve the
  toplevel, which is what actually makes it worktree-safe. Comment reflects the real
  mechanism, not the issue's literal wording.
- **#185** — `packages/entity-engine/src/engine.ts`: extracted a module-level
  `CHILD_TICKET_STATES` constant. Issue said the duplication was in 2 places
  (`setEntityState`, `bulkSetState`); direct inspection found **4** — `updateEntity` has
  two more inline copies (its "fields provided" and "fields not provided" branches).
  Fixed all 4. Typed `readonly string[]`, not `as const` — the literal-tuple type from
  `as const` would force an `as` cast at every `.includes()` call site, which
  `code-style.md` flags (assertions need a justifying comment; here there'd be nothing
  non-obvious to justify).
- **#184** — scope was substantially wider than filed. Issue named 3 files
  (`grant-access.ts`, `entity-detail.ts`, `entity-list.ts`) — the latter two don't exist
  in this repo. Traced every real `getWorkflow(tx, tenantId, instance.workflowId,
  {...})` call site (the workflow-admin-check pattern) and found the bug in **11**
  files. 9 funnel into `apps/api/src/lib/handle-entity-error.ts`, which had no
  `WorkflowError` case, so `WORKFLOW_NOT_FOUND` (thrown when the instance's workflow is
  deleted between the instance fetch and the admin-check fetch) fell to the generic 500.
  The other 2 (`add-comment.ts`, `update.ts`) called `getWorkflow` with **no try/catch
  at all** — fully uncaught, not even routed through `handleEntityError`.
  Presented 3 options to the user (fix only the 1 real named file; fix all 11 via 11
  separate per-file try/catches; fix all 11 via one central case + 2 local wraps) —
  user chose the central-fix option. Implemented:
  - `handle-entity-error.ts`: added a `WorkflowError`/`WORKFLOW_NOT_FOUND` → 404 case
    (fixes the 9 already-wrapped files for free; other `WorkflowError` codes still fall
    through to the existing generic 500, unchanged).
  - `add-comment.ts`, `update.ts`: wrapped their previously-uncaught `getWorkflow` call
    in a local try/catch routed through the same `handleEntityError`.
  - Confirmed via `error-handler.ts` (the separate, correctly-comprehensive global
    `app.onError` handler) that this route-local duplication is the codebase's existing,
    intentional pattern for `ValidationError`/`EntityError` too — not a new
    inconsistency introduced here.
- Updated `docs/specs/nit-bugs-182-185.md` and `-tasks.md` to reflect the real #184/#185
  scope and the user's explicit approval of the widened scope (both discovered
  mid-implementation, after the plan-lock was already approved — plan-lock itself
  wasn't re-drafted/re-approved for the widening since edit-gate only checks
  branch+approved:true, not scope_paths content, and the user's "go with option 1" in
  chat is the durable approval record).

### Tests added

- `apps/api/src/lib/handle-entity-error.test.ts` (new) — direct unit tests: existing
  `ValidationError`/`EntityError` mappings unchanged, new `WORKFLOW_NOT_FOUND` → 404,
  other `WorkflowError` codes still → 500 (scope precision check), unrecognized errors
  still → generic 500.
- `add-comment.test.ts`, `update.test.ts` — one new end-to-end regression test each,
  proving the real `handleEntityError` now returns 404 (not 500) via the newly-added
  try/catch. `update.test.ts` needed an additional fix to its own mock: it never
  exported `entityInstances` from the `@platform/db` mock (no existing test had
  exercised the non-admin/agent branch before — every prior test ran as `admin`), which
  surfaced as a `TypeError` (not the `WorkflowError` the test meant to simulate) on
  first attempt — fixed by adding `entityInstances: {}` to the mock.
- Did not add a duplicate end-to-end test to `grant-access.test.ts` or the other 8
  already-wrapped routes — the central `handle-entity-error.test.ts` unit test is the
  single source of truth for that mapping and covers them all; adding 8 near-identical
  route-level tests would be pure duplication for no additional coverage.

### Verification

- `pnpm typecheck` — PASS (41/41 packages)
- `pnpm lint` — PASS (41/41 packages) — caught and fixed 2 real errors first:
  `@typescript-eslint/consistent-type-imports` forbids inline `import()` type
  annotations; switched `add-comment.test.ts`/`update.test.ts`'s
  `importOriginal<typeof import("@platform/workflow-engine")>()` to a top-level
  `import type * as WorkflowEngine from "@platform/workflow-engine"` + `importOriginal<typeof WorkflowEngine>()`.
- `pnpm test` — 473 passed, 10 failed, 6 skipped (489 total). All 10 failures are
  **pre-existing and unrelated** — none touch any file this PR changed:
  - 4 in `tests/integration/view-configs.test.ts` — exactly the 4 failures already
    tracked in **issue #149**, root-caused there to local sandbox I/O latency vs. CI on
    the module-install seed path (confirmed by #149's author even against an
    unmodified checkout — not a regression).
  - 4 in `tests/integration/modules.test.ts` + 1 in `upload-flow.test.ts` — same
    signature (5000ms timeout on the same module-install seed path, one Redis
    "Connection is closed"), not yet filed as their own issue but matching #149's
    already-diagnosed root cause.
  - 1 in `tests/isolation/api-key-auth.isolation.test.ts` — a `last_used_at` timing
    assertion (`expected null not to be null`), consistent with the same
    resource-contention pattern under a fresh, minimally-provisioned single container.
  - User confirmed: do not fix #149 (or file a new issue for the other 6) as part of
    this PR — separate, already-scoped concern, follow up after this ships.
  - Targeted re-run of only the files this PR touched (`grant-access.test.ts`,
    `add-comment.test.ts`, `update.test.ts`, `handle-entity-error.test.ts`) — 28/28
    pass, confirming the 10 unrelated failures aren't masking a real regression here.
- `pnpm test:isolation` — PASS (24/24 files, 172/172 tests).

**How verification was run:** OrbStack's dev stack (`ow-database`/`ow-cache`, from
`docker compose up`) was already running but only has a `platform` DB, not
CI's `platform_test` — matches the gap noted in the 2026-07-09 session's PROGRESS entry.
Spun up plain `postgres:16-alpine` (port 5433) + `redis:7-alpine` (port 6380) matching
`.github/workflows/ci.yml`'s `test`/`isolation-tests` jobs exactly (same superuser
`platform`, same `platform_test` DB, no init script, same env var set), ran
`pnpm db:migrate` against it, then `pnpm test` / `pnpm test:isolation`. Removed both temp
containers after the run; did not touch the pre-existing dev stack.

### Next

- PR for `chore/PLAT-182-nit-bugs-batch` targeting `main` (not PR #181).
- Follow-up (separate, not started): issue #149 (view-configs.test.ts timeouts) —
  user explicitly deferred this to after the current PR ships. Worth filing a new issue
  for the other 6 timeouts (`modules.test.ts` x4, `upload-flow.test.ts` x1,
  `api-key-auth.isolation.test.ts` x1) sharing #149's root cause, if the user wants that
  tracked before the follow-up pass.

### Open questions

- None blocking. Scope-expansion decisions for #184 (11 files vs. 3 named) and #185 (4
  call sites vs. 2 named) were both surfaced to and approved by the user before
  implementation.
