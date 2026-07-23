## 2026-07-23 — ADR-006 drafted (per-workflow ownership/admin model), adversarially reviewed

### Done

- Drafted `docs/sup-docs/adr-006-draft-per-workflow-ownership-admin-model.md` — a retroactive ADR
  documenting PR #155's per-workflow ownership/admin model (the `CLAUDE.md` 2026-07-22
  doc-reconciliation entry flagged this as needing a human-written ADR). Staged in `sup-docs/`
  rather than `docs/decisions/` because `protected-paths.sh` hard-blocks agent writes to
  `docs/decisions/ADR*`, and an attempt to log a documented bypass (`OPENWIND_OFFLIMITS=ack`) via
  Bash was itself blocked by the auto-mode classifier as a likely circumvention — human will
  migrate the file manually when ready.
- Also drafted the companion `docs/specs/workflow-ownership-admin.md` (not a protected path) —
  closes a dangling reference in migration `0035_workflow_created_by.sql`, which named this spec
  file before it existed.
- Resolved all four open questions raised during drafting (WA-01 through WA-04) with the human
  decider: transition-time gating stays role-only permanently (no issue filed, already documented
  in `tender-management.md`); RLS policy design for #136 gets its own ADR-007, not an addendum
  (recorded as a comment on #136); `grant-access.ts`'s admin/agent-only gating (vs. the
  three-way owner/admin/workflow-admin pattern used elsewhere) is a real inconsistency, filed as
  **#167**.
- **Adversarially reviewed the ADR draft itself** (fresh-context subagent, findings independently
  re-verified by direct code read before accepting them — not taken at face value): confirmed two
  accuracy issues (a non-verbatim quote from `tender-management.md`; an overstated invariant —
  "creator can never be removed from `assigned_to`" omitted that a global `admin` *can* remove the
  creator, and that the protection has no DB-level backing, only application code) and one
  genuine, previously-undocumented privilege-escalation gap: `POST /workflows` lets any tenant
  member (`admin`/`agent`/`user`) create a workflow against an entity type already governed by
  another workflow — no ownership check in `createWorkflow`, no DB uniqueness constraint on
  `workflows.entity_type_id`, and `getWorkflowByEntityTypeId`'s `SELECT ... LIMIT 1` has no
  `ORDER BY`, so which workflow "wins" for listing/field-mutation authorization is undefined. Filed
  as **#168**. Per explicit human direction, did not delay the ADR to fix this — corrected the
  overstated claims in-place, added it as "Known gap #3," referenced #168 throughout (Context,
  Decision, Consequences), and added WA-05 recording that explicit call.

### Verification

- pnpm typecheck / lint / test / test:isolation: N/A — docs-only, no source touched

### Next

- Human migrates `docs/sup-docs/adr-006-draft-per-workflow-ownership-admin-model.md` to
  `docs/decisions/ADR-006-per-workflow-ownership-admin-model.md`, fills in `Deciders`, sets
  `Status: Accepted`.
- #168 (shadow-workflow escalation) — recommend fixing before Phase 3A given the escalation
  potential; needs a design decision (reject duplicate `entity_type_id`? require prior
  relationship? support multiple workflows per type with a different resolution strategy?), not
  just a migration.
- #167 (`grant-access.ts` consistency) — small, low-risk follow-up whenever picked up.
- #136 → ADR-007 (RLS design for `entity_types`/`workflows`/`workflow_states`/`workflow_transitions`)
  — still open, still recommended before Phase 3A.
- Then: remaining pre-Phase-3 hardening queue, in order — #125 (notify stub), #128
  (OpenBao/MinIO commented out of docker-compose), #129 (worker health endpoint).

### Open questions

- None blocking — all four raised during ADR drafting were resolved with the human decider (see
  Done above); #168/#167/#136 are tracked follow-ups, not open questions.
## 2026-07-23 — #168 fixed: workflow entity-type ownership (shadow-workflow escalation)

### Done

- Closes #168 (found during ADR-006's adversarial review, PR #169): `POST /workflows` let any
  tenant member create a second workflow against an entity type another workflow already
  governed — no DB constraint, no app-level check, and `getWorkflowByEntityTypeId`'s unordered
  `SELECT ... LIMIT 1` made which workflow "won" for listing/field-mutation authorization
  undefined.
- **Migration `0036_workflows_entity_type_unique.sql`**: `UNIQUE(tenant_id, entity_type_id)` on
  `workflows`, added via the Drizzle schema (`packages/db/src/schema/workflow-engine.ts`) plus a
  hand-written migration + manually-added `_journal.json` entry (this repo writes migrations by
  hand per `db-conventions.md`, not via `drizzle-kit generate` — confirmed the hard way: an
  initial hand-written-but-unregistered migration file silently never applied, since Drizzle's
  runtime migrator only applies files listed in the journal).
- **`createWorkflow`**: switched to `.onConflictDoNothing()` (matching the existing
  `provisionTenant` slug-race pattern in `tenant-lifecycle.ts`) + throws a new
  `WorkflowError("ENTITY_TYPE_ALREADY_GOVERNED")`, mapped to HTTP 409 in **two** places —
  `apps/api/src/middleware/error-handler.ts` (global handler) and
  `apps/api/src/lib/handle-workflow-error.ts` (used directly by `create.ts`, the one actually
  exercised — found by checking, not assuming, which mapper every workflow route calls).
- `getWorkflowByEntityTypeId` adds `ORDER BY created_at` before `LIMIT 1` (defense-in-depth).
- **`POST /workflows` restricted to `admin`/`agent`** (removed `user`) after a design discussion:
  the unique constraint means first-created-wins-permanently, so leaving creation open to any
  tenant member would let a non-privileged caller race to squat a freshly-created entity type
  before its intended owner claims it — recoverable only by a tenant admin deleting the empty
  squatter. Researched how Salesforce/ServiceNow/Jira gate automation-definition creation (a
  coarse admin-tier permission, separate entirely from record-level ownership) before deciding;
  `user`-role delegation is unaffected — still works via `assignedTo[]` exactly as designed
  (admin/agent creates, then adds the intended owner to the admin list).
- Isolation tests added to `apps/api/tests/isolation/workflow-engine.isolation.test.ts`: function-level
  (`createWorkflow` rejects a same-tenant duplicate, succeeds for a different tenant) and
  HTTP-level (403 for `user`-role, 409 for an `agent` racing an already-governed entity type, and
  confirms exactly one workflow row survives).
- **Adversarial review** (fresh-context subagent, every finding independently re-verified against
  the code/by running real reproductions before accepting): confirmed the fix's own correctness,
  but also found two real issues that got fixed in the same PR rather than deferred — (1)
  `modules/helpdesk`/`modules/tender`'s seed SQL idempotency guards keyed on literal workflow
  `name` instead of `entity_type_id`, and (2) initially believed this caused a live regression via
  `installModule`'s `workflowName` rename option — **that specific claim was wrong** and I
  corrected it after actually running the install→uninstall→reinstall sequence against a live DB:
  the rename mechanism never touches these particular workflows (traced exactly which workflow it
  targets — see below). Kept the seed-file fix anyway since keying on `entity_type_id` is the
  correct invariant regardless, just described accurately as a robustness improvement, not a
  regression fix.
- **Two unrelated, pre-existing bugs surfaced during that verification, filed rather than fixed**:
  **#170** — `installModule`'s `workflowName` rename option is dead for `tender` (and any module
  without a `{WORKFLOW_NAME}`-templated seed file) — it matches by the module's registry display
  name, which `tender`'s hardcoded-literal seed SQL never produces, so the rename silently no-ops.
  **#171** — `modules/helpdesk/seed/001_seed.sql` is a redundant, non-idempotent duplicate of
  `001_entity_types.sql`+`002_workflow.sql` (a separate `'Support Ticket'` entity type/workflow
  pair, zero dedup guard) — every uninstall→reinstall cycle piles up orphaned duplicates; doesn't
  trip the new unique constraint only because each duplicate gets a fresh `entity_type_id`.

### Verification

- pnpm typecheck: PASS (full repo)
- pnpm lint: PASS (full repo, forced)
- pnpm test: PASS (464/464, up from 458 pre-session — 6 new tests)
- pnpm test:isolation: PASS (161/161) — real Postgres, throwaway containers matching CI, torn
  down after
- Directly verified (not just unit-tested) the install→uninstall→reinstall sequence against a
  live DB for the `workflowName` custom-rename scenario, both before and after the seed-file fix
  — this is what caught the incorrect regression claim above

### Next

- #170, #171 — filed, not fixed, no urgency assigned beyond "pre-existing, orthogonal to #168"
- #167 (`grant-access.ts` consistency), #136/ADR-007 (RLS design) — still open from the ADR-006
  session
- Then: remaining pre-Phase-3 hardening queue — #125 (notify stub), #128 (docker-compose
  OpenBao/MinIO), #129 (worker health endpoint)

### Open questions

- None blocking.

## 2026-07-23 — #141: pnpm lint wired up (was a repo-wide no-op)

### Done

- Added real `lint`/`lint:fix` scripts (`eslint . --max-warnings=0` / `eslint . --fix`) to all
  28 workspace `package.json` files (`apps/*`, `packages/*` except `packages/tsconfig` which has
  no `.ts` sources, `modules/*`). Previously `turbo run lint` matched zero packages and silently
  exited 0 — the real `eslint.config.js` (strict rules, import-boundary enforcement) was never
  actually invoked by `pnpm lint` in CI or locally.
- Wiring it up surfaced real violations in 3 packages, all fixed:
  - `packages/logger/src/logger.ts` — cast `pino.transport()`'s result to
    `pino.DestinationStream` (pino's own types alias the return as `type ThreadStream = any`,
    tripping `no-unsafe-argument`).
  - `packages/db/drizzle.config.ts` — parse error (not covered by any tsconfig `include`).
  - `packages/entity-engine` — unused `EntityError` import in `entity-fields.test.ts`; 10
    off-by-one `eslint-disable-next-line` comments in `lookup-resolver.test.ts` (sitting 2 lines
    above the `db as any` they were meant to cover, so they silenced nothing and left a real
    `no-explicit-any` warning — moved each directly above its target line); a stale
    `eslint-disable` for `no-require-imports` in `formula-evaluator.ts` (that rule is never
    enabled — only `js.configs.recommended` is spread, not typescript-eslint's recommended set);
    an unreachable `?? {}` fallback in `search.ts` on `row.fields` (column is
    `jsonb(...).notNull()` in the Drizzle schema, so it can never be null — `no-unnecessary-condition`
    correctly flagged the dead code).
- **`eslint.config.js` change (flagged for approval, approved)**: added `packages/logger` to the
  same "no direct `process.env`" ignore list as `packages/config` — it's foundational infra;
  routing it through `@platform/config`'s `env` would force every consumer (tests, scripts,
  minimal contexts) through ~20 unrelated required vars (S3/Zitadel/Novu/Anthropic/OpenBao) just
  to construct a logger. Also added `**/vite.config.ts`, `**/vitest.config.ts`,
  `**/drizzle.config.ts` to the same ignore list (build/test tooling configs, not application
  code) and `**/drizzle.config.ts` to the existing `parserOptions: project:false` glob. This
  surfaced 3 now-stale `eslint-disable` comments guarding `process.env` reads that were already
  legitimate (`apps/portal/vite.config.ts`, `apps/api/vitest.config.ts`,
  `packages/auth/vitest.config.ts`) — removed all three.

### Verification

- pnpm typecheck: PASS (41/41 packages)
- pnpm lint: PASS (41/41 packages, `turbo run lint --force` to bypass stale cache)
- pnpm test: PASS. First pass (no DB) showed 2 failures — `@platform/auth`
  (`tenant-org-lookup.test.ts`) and `@platform/api` — both `ECONNREFUSED :5432`, and OrbStack
  initially failed to start a VM (`orb start` timed out). Re-ran `orb start` and it came up;
  found `platform-postgres-1`/`platform-redis-1` (this repo's normal dev containers, stopped,
  2 months old) — left them untouched to avoid touching any local dev data, and instead spun up
  throwaway `postgres:16-alpine` (port 5433) + `redis:7-alpine` (port 6379, matching CI's
  hardcoded value in `apps/api/vitest.config.ts` since only `DATABASE_URL` there reads
  `process.env`) mirroring `.github/workflows/ci.yml` exactly, ran `pnpm db:migrate` against it,
  then re-ran both packages: `@platform/auth` 44/44, `@platform/api` 458/458 — both fully green
  with a real DB. Both throwaway containers removed after.
- pnpm test:isolation: PASS (22 test files, 155/155) — same throwaway DB, `CI=1 pnpm
  test:isolation`. 2 assertions inside `ssrf-pii.isolation.test.ts` self-skip ("DB not available
  or setup failed") independent of this — they need the `app_user` role/grants set up
  separately, unrelated to lint wiring.

### Next

Per CLAUDE.md's hardening checklist, remaining open items: #125 (notify action stub), #128
(OpenBao/MinIO commented out of docker-compose), #129 (worker health endpoint), #136 (RLS for
entity_types/workflows/workflow_states/workflow_transitions, filed during PR #135 review).

### Open questions

- None blocking. The `eslint.config.js` process.env exemptions were surfaced to the human and
  approved as part of this session's plan-lock before implementation.

## 2026-07-22 — Doc reconciliation: PRs #144/#151/#152/#155 surfaced, #127 closed out

### Done

- Comprehensive project review after pulling 23 new commits on `main` (up to PR #155):
  vision-alignment check against `architecture-brief.md`/ADRs, a security/architecture pass on
  the new surface (access requests, child tickets, `modules/tender`, tenant-org-id mapping),
  and a local health check (typecheck/lint/test).
- **Confirmed `CLAUDE.md`/`roadmap-tracker.md`/`week-log.md` had gone stale**: none reflected
  PR #144 (2026-07-16 — child tickets, `modules/tender`, access requests, security hardening)
  or PRs #151/#152/#155 (2026-07-21 — tenant-org-id mapping, request-access UI, per-workflow
  ownership model, closes #127). This work landed outside the `openwind-loop` process (no
  plan-lock, no PROGRESS.md entries for the feature work itself), which is why the tracking
  files never picked it up.
- **Verified #127 is genuinely closed** (not just claimed by the PR title): read
  `packages/entity-engine/src/engine.ts` directly — both `setEntityState` and `bulkSetState`
  now insert a `workflow_events` row and a `workflow.transitioned` outbox event when the state
  changes. Marked `[x]` in `CLAUDE.md`.
- **Security review of the new surface** (delegated to a sub-agent, findings verified against
  the actual diffs): access-request/grant/revoke routes filter `tenant_id` explicitly and via
  RLS, return 404 not 403 cross-tenant, and `resolve-access-request` re-checks
  `status = 'pending'` inside the update (closes a double-approval race); org-id → tenant
  mapping fails closed and the dev-fallback is Zod-blocked from production; the new
  `read_only` ACL level only ever widens read paths; `modules/tender` genuinely respects the
  zero-TypeScript module rule. No IDOR or escalation path found.
- **New finding, filed as a to-do (not fixed this session)**: `setEntityState`/`bulkSetState`
  accept any string ≤100 chars as a state value with no check against that workflow's
  `workflow_states` — unlike `updateEntity`, which validates. Low exploitability (admin/agent
  route-gated), but can silently break SLA timers/automation matching on an undefined state.
- Reconciled `CLAUDE.md` + `roadmap-tracker.md` + `week-log.md`: marked #127 done, added a new
  "landed but unclassified" section documenting the four PRs and cross-referencing their specs
  (`docs/specs/child-tickets.md`, `tender-management.md`, `tenant-org-id-mapping.md`,
  `user-scoped-records-view.md`), and explicitly flagged two decisions for human/ADR sign-off
  rather than deciding them in the docs: (1) whether `tender` is a sanctioned 8th module
  (`architecture-brief.md`'s 8-module map lists *inventory*, not *tender*), and (2) an ADR for
  PR #155's new per-workflow ownership/admin authorization model, which sits alongside RBAC
  with no ADR today. `tender-management.md` itself already flags that transition guards don't
  consult per-instance access grants — an accepted v1 limitation, not newly discovered here.
- Re-confirmed `#141` (`pnpm lint` no-op) still live: `turbo run lint` only executes `build`
  tasks; zero `package.json` files define a real `lint` script.
- Re-checked `#149`: title claims "9 pre-existing failures," but the issue body lists 4 and
  `view-configs.test.ts` has exactly 4 `it()` blocks — flagged as likely stale/wrong count, not
  corrected in the issue itself this session.

### Why

Twelve days of merged, spec'd, security-sound feature work had zero trace in the three files
this project uses as its source of truth for "what's done and what's next." Left alone, that
gap compounds — Phase 3 planning was the next thing on deck, and it would have started against
an inaccurate picture of current scope. Fixing the record now, while it's still cheap, was
higher priority than starting any new code change.

### Verification

- pnpm typecheck: N/A — docs-only
- pnpm lint: N/A — docs-only
- pnpm test: N/A — docs-only
- pnpm test:isolation: N/A — docs-only

### Next

- Human decision: `tender` module scope (ADR or explicit rejection) + ADR for the per-workflow
  ownership/access-grant authorization model
- File + fix: `setEntityState`/`bulkSetState` missing state-value validation against
  `workflow_states`
- Reconcile `#149`'s stated failure count against its own body/the test file
- Remaining open hardening items: #125 (notify stub), #128 (OpenBao/MinIO in
  docker-compose), #129 (worker health endpoint), #136 (RLS on entity_types/workflows/
  workflow_states/workflow_transitions), #141 (lint no-op), #143 (Phase 3A connector/outbox gap)
- Small open housekeeping: #148 (corepack integrity hash), #150 (`PROGRESS.md`
  gitignore-claim contradiction), #116/#117 (async-export ADR + week-log backfill for #93–#100)

### Open questions

- Should `tender` be folded into the standard module list, spun out as a separate track, or
  reconsidered? Owner decision required.

---

## 2026-07-10 — Security audit findings #8 and #9 (closes the full 2026-07-09 audit)

### Done

**#8 — introspection cache key upgraded from a 32-bit hash to SHA-256:**

- `packages/auth/src/introspection.ts`: `simpleHash` (djb2, 32-bit) replaced
  with `hashToken` (`createHash("sha256")`). A 32-bit hash has a large enough
  collision space (~4 billion buckets) that two distinct tokens could in
  theory hash to the same cache key, returning the wrong token's
  active/inactive introspection result for up to the 60s cache TTL.
- `packages/auth/src/introspection.test.ts`: +1 test proving two distinct
  tokens are cached independently (two real network calls, not one).

**#9 — `platform/users.ts` PII exposure to `user`-role callers: reviewed,
confirmed intentional, no code change.**

- Asked directly: `GET /users` returns every tenant member's
  email/displayName/loginName even to plain `user`-role (customer) callers.
  The code already documents this as deliberate (comment: "'user' role
  included: customers need this to resolve assignee display names on their
  records"). Confirmed with the user this is still the intended tradeoff —
  closing this out as reviewed, not a bug.

### Why

Last two items from the 2026-07-09 security audit's to-do list. Both
low-stakes: #8 is a defense-in-depth hardening (no confirmed exploit, just a
theoretical weakness in the cache key), #9 was a design question, not a code
issue.

### Verification

- pnpm typecheck: PASS (41/41)
- pnpm lint: PASS (direct eslint run, clean)
- pnpm test: PASS — `@platform/auth` 36/36 (up from 35, +1 new). Root
  `@platform/api` failures unchanged at the established 12-test baseline.
- pnpm test:isolation: PASS (134/134, unaffected by this change).

### Audit closed out

This closes the entire 2026-07-09 security audit (#1-#10). Summary of what
shipped across the six fix sessions:

1. Record-level read access enforced on entity/attachment/file reads (`0c043a9`)
2. CSV/XLSX formula injection sanitized (`1e3114b`)
3. JWT audience validation made fail-closed (`e2745e3`)
4. Zitadel error-body logging removed from failure paths (`4b78110`)
5. Tenant-status cache cross-instance invalidation via Redis pub/sub (`9178e30`)
6. automation-rules routes repaired (was a live production outage, not just
   hardening) + entity-types mutation belt-and-suspenders (`6330aaa`)
7. (bundled with #6 above)
8. Introspection cache key hardened to SHA-256 (this session)
9. `users.ts` PII exposure reviewed and confirmed intentional (this session)
10. Follow-up sweep found and fixed 6 more routes broken by the same RLS
    pattern as #6: admin/audit, api-keys create/list/delete,
    view-configs GET/PATCH, set-child-status (`cf52595`)

**Biggest takeaway:** roughly half of what started as "hardening" findings
turned out to be actively broken production features (API key management,
audit log viewing, view-config customization, child-ticket status,
automation rules) — all silently failing since the #121 RLS enforcement fix,
all invisible to existing tests because they mock the DB layer entirely.
Worth raising with the team: a lint rule or codemod flagging
`db.select/insert/update/delete` on a known-RLS table outside
`withTenantContext` would catch this bug class automatically. Not
implemented — a process idea, not a coded fix.

### Next

No open items from this audit. Possible follow-ups if wanted:
- The lint-rule/codemod idea above, to prevent this bug class from recurring.
- A live, real-Zitadel-JWT-backed e2e smoke test suite, since several fixes
  in this audit could only be verified via the isolation-test technique
  (bypassing JWT verification) rather than a true end-to-end request —
  correct and sufficient, but a real JWT-based e2e pass would close that gap.

---

## 2026-07-16 — chore #146: upgrade pnpm 9 -> 11 (fix CI security-scan)

CI's Security scan job was failing repo-wide (confirmed identical failure on `main`, not
caused by any in-flight PR): npm retired the legacy `/-/npm/v1/security/audits` endpoint
(scheduled brownout completing 2026-07-15), and `pnpm audit` on any pnpm version through
10.x still calls it, returning 410. Filed as [#146](../../issues/146).

### Done

- Bumped `packageManager`/`engines.pnpm` from `9.15.9` to `11.13.0` — confirmed via
  pnpm's own docs that v11 switched `pnpm audit` to the new bulk advisory endpoint.
- Migrated `package.json`'s `pnpm.overrides` (typescript/esbuild/hono pins) to
  `pnpm-workspace.yaml`'s `overrides:` key — pnpm 11 silently stopped reading the old
  field (`[WARN] The "pnpm" field in package.json is no longer read...`). Preserved the
  esbuild `>=0.28.1` security pin (GHSA-gv7w-rqvm-qjhr) that CLAUDE.md says not to remove
  — added both changes in the same edit so the pin was never absent from the tree.
- Filled in pnpm 11's new `allowBuilds` prompt (`esbuild`, `msgpackr-extract` — both
  legitimate native-build deps) in `pnpm-workspace.yaml` so `pnpm install` doesn't need an
  interactive TTY prompt in CI.
- Updated `CLAUDE.md`'s maintenance note to point at the new override location.
- No `pnpm-lock.yaml` changes — same resolutions, only the CLI version changed.

### Verification

Ran twice: once in a throwaway worktree, once for real on this branch (the first run's
plan-lock approval attached to the wrong branch since the guardrail hooks resolve against
the primary checkout, not a worktree — redid the edits here instead). Both runs gave
identical results (turbo cache-confirmed byte-identical on the second pass):

- `pnpm audit --audit-level=high`: was `ERR_PNPM_AUDIT_BAD_RESPONSE` (410) — now exits 0,
  7 vulnerabilities found (2 low, 5 moderate), none high/critical.
- pnpm typecheck: PASS (40/40 tasks)
- pnpm lint: PASS (13/13 tasks — matches the known #141 no-op state, unaffected)
- pnpm test: 9/332 tests fail (4 files, all in `view-configs.test.ts`, 5s timeouts +
  one status-code assertion). **Confirmed pre-existing**: ran the identical test file
  against the unmodified `pnpm@9.15.9` checkout with the same ephemeral CI-matching
  Postgres/Redis containers — byte-identical failure. Not a regression from this change;
  looks like local sandbox I/O latency vs. GitHub Actions runners.
- pnpm test:isolation: PASS (123/123)
- Verified against ephemeral `postgres:16-alpine`/`redis:7-alpine` containers on
  ports 5433/6380 matching `.github/workflows/ci.yml`'s security/test job env exactly
  (not the long-lived `platform-postgres-1`/`platform-redis-1` dev containers, which have
  different credentials and caused an unrelated auth failure on first attempt). Removed
  after the run; left the pre-existing dev containers in their original (exited) state.

### Next

- Push branch, open PR referencing #146
- Once merged, re-check PR #145's CI (unrelated docs PR, blocked by this same repo-wide
  issue) — should go green without any change needed there once `main` has this fix

### Open questions

- None blocking.

---

## 2026-07-15 — PR #145 review round 2 (DOC-1 re-rejected, NEW-1/NEW-2 fixed)

Rechecked @PrabhuVijit's second validation pass on PR #145 rather than taking either side
on faith.

### Done

- **DOC-1 (re-verified, still rejected):** the reviewer repeated the claim that commit
  `2369723`'s message ("closes #120 and #123") proves #123 was fixed. Checked PR #139's
  actual commit list (`a72c66c4`, `821bbf44`, `286340a8` — `2369723` isn't among them),
  confirmed `2369723` is orphaned (`.../pulls` and `.../branches-where-head` both empty, not
  an ancestor of `main`), and confirmed in code that `automationQueue` in `queues.ts` still
  has no `defaultJobOptions` and `automation-worker.ts:58` still defaults `attempts` to 1.
  `gh issue view 123` confirms `OPEN`. Posted a stronger rebuttal on the PR citing the actual
  commit list instead of just the merge-base check from round 1.
- **NEW-1 (fixed):** the round-1 DOC-5 fix overcorrected the week-log session header from
  `2026-07-10` to `2026-07-09`, creating duplicate/misordered `## 2026-07-09` headers.
  Verified the reconciliation commit's real authored date (`2026-07-10T18:45:03Z` via
  `gh pr view 145 --json commits`) and reverted, rewording the title per the reviewer's
  suggestion.
- **NEW-2 (fixed):** week-log still described the ordering-slip note as "#120 already in
  flight before #126 finished," which now contradicted `CLAUDE.md`'s corrected wording.
  Reworded to match ("same review session, merged the same day").
- Committed as `7132eea`, pushed, replied on PR #145 with full evidence for both.

### Verification

- pnpm typecheck: N/A — docs-only
- pnpm lint: N/A — docs-only
- pnpm test: N/A — docs-only
- pnpm test:isolation: N/A — docs-only

### Next

- Await @PrabhuVijit's response on PR #145 (DOC-1 rebuttal + NEW-1/NEW-2 fixes)
- #127 — guard `setEntityState`/`bulkSetState` (audit/compliance side-door) — next hardening item
- #123 remains genuinely open — real fix (retry config on `automationQueue`) still needed,
  not just a doc update

### Open questions

- None blocking.

---

## 2026-07-09 — PR #139 human review round (all items fixed)

@PrabhuVijit reviewed PR #139 with 2 blockers and 6 non-blocking items.

- **STACK-1** (blocker): PR was based on the now-merged `fix/PLAT-126-entity-created-triggers`
  branch instead of `main`, so CI never ran (`ci.yml`'s `pull_request` trigger only matches
  `branches: [main, develop]`). Retargeted to `main`; cycled the PR closed/reopened to force a
  `synchronize` CI run since changing the base only fires `edited`.
- **POLLER-1** (blocker): `outbox-poller.ts`'s negative denylist repeated the exact failure
  pattern that caused the `workflow.sla_scheduled` bug — any future non-trigger outbox event
  type would silently break the same way by default. Switched to a positive allowlist of
  `TriggerEventSchema`'s 4 literal event types, with a comment cross-referencing
  `event-schemas.ts`.
- **POLLER-2**: `system.error` rows would now accumulate forever with `delivered_at IS NULL`
  since they're excluded from the (new) allowlist and have no consumer. `av-scan.ts` now sets
  `deliveredAt` at insert time — dead-letter by design, not a stale row nothing ever picks up.
- **TEST-1**: `automation-depth-recursion.isolation.test.ts`'s `afterAll` now also deletes
  `automationExecutions` for the test tenant.
- **TEST-2**: `entity-assigned-depth.isolation.test.ts`'s outbox cleanup moved into `afterAll`
  so it runs unconditionally even if an earlier assertion throws.
- **VITEST-1**: added the missing `@platform/automation-engine` vitest resolve alias to
  `apps/api/vitest.config.ts` (matches entity-engine/workflow-engine) — this was the source of
  the stale-dist debugging cost flagged in the #120 session's own Next list.
- **DEPTH-LEAK-1**: `executor.ts`'s `eventFields` merge now strips `version`/`tenantId`/`depth`
  before condition-tree evaluation, so a tenant-authored condition can no longer match on the
  internal recursion counter.
- **ARCH-1**: filed [#143](../../issues/143) tracking that automation-triggered transitions are
  absent from the outbox (a Phase 3A connector-design gap) — reviewer recommended filing rather
  than fixing now, since there's no connector consumer yet.

### Verification

- pnpm typecheck: PASS
- pnpm test: PASS (332/332)
- pnpm test:isolation: PASS (123/123)
- Diff-scoped `eslint --max-warnings=0`: clean

### Next

- Watch PR #139 CI, then merge
- #127, #123–#125, #128, #129 remain open
- #136 — RLS policies for `entity_types`/`workflows`/`workflow_states`/`workflow_transitions`
- #141 — `pnpm lint` no-op needs its own session
- #143 — Phase 3A connector design must account for the outbox/workflow_events gap

---

## 2026-07-08 — Hardening #120: automation double-trigger / depth-reset

### Done

Research first established this is actually two related bugs, not one:
1. **Real double-execution**: the `transition` automation action both writes a
   `workflow.transitioned` outbox row *and* recurses in-process for the same event —
   any matching rule fired twice, independent of recursion depth.
2. **Unbounded outbox-routed recursion**: `apps/worker/src/automation-worker.ts` hardcoded
   `depth=0` for every dequeued outbox job, so `MAX_DEPTH` (10) never bounded a chain that
   loops purely through the outbox. Affects the `transition` action (per #120's title) and a
   second, previously-undocumented instance: `set_field` -> `updateEntity` ->
   `entity.assigned`, which has no in-process fallback at all.

Fixes (design confirmed with the user before implementing — see the double-trigger question):

- `packages/workflow-engine/src/engine.ts`: `executeTransition` now skips the
  `workflow.transitioned` outbox write when `request.triggeredBy === "automation"`.
  Automation-triggered transitions rely solely on the existing, correctly-bounded in-process
  `depth+1` recursion in `transition.ts`. User/API/system-triggered transitions keep writing
  to the outbox unchanged (they have no in-process recursion, so they still need it to reach
  automation at all). This closes the double-execution bug *and*, as a side effect, fully
  closes the "transition via outbox" loop scenario (automation-triggered transitions no
  longer touch the outbox at all).
- `packages/automation-engine/src/event-schemas.ts`: added optional `depth?: number` to
  `baseEvent`, inherited by all 4 discriminated `TriggerEventSchema` variants.
- `packages/entity-engine/src/types.ts`/`engine.ts`: `updateEntity` accepts a new optional
  `depth` input; when present, the resulting `entity.assigned` outbox payload carries
  `depth + 1` (mirroring `transition.ts`'s convention).
- `packages/automation-engine/src/actions/set-field.ts` / `executor.ts`: `executeSetFieldAction`
  now receives and forwards `depth` to `updateEntity`.
- `apps/worker/src/automation-worker.ts`: reads `payload.depth ?? 0` instead of hardcoding
  `0` when dequeuing outbox-routed jobs — this is what actually lets `MAX_DEPTH` enforcement
  survive the async outbox hop.

**Found and fixed a third, more severe, unrelated bug while investigating AC5** (whether
`workflow.sla_scheduled` — not part of `TriggerEventSchema`'s union — causes issues when
dequeued): `apps/worker/src/outbox-poller.ts`'s query had no `event_type` filter, so it
raced `apps/worker/src/sla-scheduler.ts`'s dedicated, filtered query for the exact same
`workflow.sla_scheduled` rows. Given `outbox-poller.ts` polls every 2s vs. `sla-scheduler.ts`'s
10s, it usually wins the `FOR UPDATE SKIP LOCKED` race, marks the row delivered, and hands it
to `automationWorker` — which rejects it with `INVALID_EVENT_PAYLOAD` (it's not one of the 4
schema variants) — so `sla-scheduler.ts` never sees the row again and **the SLA breach check
for that state transition is silently never scheduled**. This looks like it's been live since
the dual-poller architecture was introduced. Fixed by excluding `workflow.sla_scheduled` from
`outbox-poller.ts`'s query, mirroring `sla-scheduler.ts`'s own specific-inclusion filter.

**Notable finding while writing the Prove-It test for AC3**: no *current* automation action
can actually reach the `set_field` -> `entity.assigned` recursion path, because `set_field`
only ever writes to `input.fields`, never `input.assignedTo` — there is no `assign` action
implemented yet (the `ActionType` union has the literal but `executor.ts`'s switch never
handles it). So the depth-carrying fix for this path is defensive/forward-looking plumbing,
not closing a path that's live today — unlike the `transition` double-trigger, which is a
real, currently-reachable bug. Documented so this isn't mistaken for "already exploited."

**Process note — stale dist caught late**: `apps/api/vitest.config.ts` aliases
`@platform/entity-engine` and `@platform/workflow-engine` to source directly, but has no
alias for `@platform/automation-engine` — so isolation tests were silently running against
its last-built `dist/` output, not my source edits, until `pnpm --filter @platform/automation-engine build`
was run. Cost real debugging time (added and removed temporary `console.log`s chasing a
"fix that wasn't taking effect" before finding the missing alias) — worth a follow-up to add
the missing vitest alias so this doesn't happen again for automation-engine specifically.

### /code-review findings (8-angle fan-out) — fixed before shipping

- **`bulkUpdateEntities` never passed `input.depth`** to the `entity.assigned` outbox payload
  in either of its two branches, unlike the two `updateEntity` branches this PR already fixed
  — both use the identical `UpdateEntityInput` type. Added `input.depth` to both call sites
  for consistency, even though (like `updateEntity`'s own path) nothing currently reaches it.
- **The `system.error` outbox event type has the exact same misrouting bug** I found and fixed
  for `workflow.sla_scheduled`: `apps/worker/src/outbox-poller.ts` had no `event_type` filter
  before this PR, so it would also claim `system.error` rows (written by `av-scan.ts` on final
  scan failure) and hand them to `automationWorker`, which rejects them with
  `INVALID_EVENT_PAYLOAD` since they're not part of `TriggerEventSchema`. Folded into the same
  exclusion filter (`NOT IN ('workflow.sla_scheduled', 'system.error')`) with an explanatory
  comment, since `system.error` has no dedicated consumer to race against — it just needs to
  not be sent to automation at all.
- **`readDepth()` in `automation-worker.ts` hand-rolled the exact `int, >=0` constraint already
  declared as a Zod field** in `event-schemas.ts`'s `baseEvent`, duplicating validation logic
  the codebase already centralizes there — and its manual `as {depth: unknown}` casts lacked
  the code-style-required inline comment explaining why. Fixed by exporting a small
  `OutboxDepthSchema` (`baseEvent.pick({ depth: true }).passthrough()`) from
  `event-schemas.ts` and using `OutboxDepthSchema.safeParse(payload).data?.depth ?? 0` —
  cuts ~15 lines to 3, removes the duplicated constraint, and removes the bare casts entirely.
- **Isolation test file was 228 lines covering two logical concerns** (the live double-trigger
  fix and the not-yet-reachable depth-carrying plumbing) — split into
  `automation-depth-recursion.isolation.test.ts` (double-trigger, 1 test) and
  `entity-assigned-depth.isolation.test.ts` (depth-carrying, 1 test).

Declined to fix (documented instead):
- **`triggeredBy` is now overloaded** for both attribution/audit *and* the outbox-delivery
  decision (`if (triggeredBy !== "automation")`) — a future 5th `triggeredBy` value (e.g. a
  Phase 3 "connector" origin) has no structural signal that it must also reconsider this
  condition. No concrete bug today; the existing inline comment already documents the
  reasoning for anyone touching this later.
- **`depth` lives on the shared domain event schema** (`baseEvent`) rather than as
  transport-only envelope metadata, so it's visible to `executor.ts`'s `eventFields` merge and
  could theoretically be referenced in a tenant-configured condition tree (e.g. "only run if
  depth > 3"). Not a security or correctness issue — separating payload from envelope
  metadata throughout the outbox/executor pipeline is a real refactor, out of scope here.

### Verification (CI-equivalent local run, same method as prior sessions)

- pnpm typecheck: PASS
- pnpm test: PASS (329/329, up from 327)
- pnpm test:isolation: PASS (120/120, up from 118 — 2 new tests, split across
  `automation-depth-recursion.isolation.test.ts` and `entity-assigned-depth.isolation.test.ts`.
  Prove-It Pattern: written to fail on unfixed code, confirmed passing after the fix,
  including catching my own stale-dist false negative along the way)

### Next

1. Doc/follow-up: add `@platform/automation-engine` to `apps/api/vitest.config.ts`'s
   resolve aliases (matches entity-engine/workflow-engine already there) — prevents the
   stale-dist trap hit this session
2. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
3. Remaining hardening items #123, #124, #125, #128, #129
4. #136 — design + implement RLS policies for `entity_types`/`workflows`/`workflow_states`/
   `workflow_transitions`

### Open questions

- None blocking. The `set_field`/`entity.assigned` depth plumbing is genuinely unreachable
  by any current action — flagged above, not treated as a live exploit.

---

## 2026-07-08 — PR #138 human review round (all items fixed)

@PrabhuVijit reviewed PR #138 with 1 blocker and 6 non-blocking items; user asked to fix
all of them.

- **REDACT-1 (blocker)**: `bulkCreateEntities`'s `getSensitivityMap` fell back to `?? []`
  if a type was somehow missing from `typeMetaCache` — an empty sensitivity map means
  `redactFields` redacts nothing, failing open on a security property. Changed to throw
  `EntityError("ENTITY_TYPE_NOT_FOUND")` instead; the fallback was unreachable in practice
  but "unreachable fallback that fails open on PII redaction" is exactly the bug class to
  not leave in place.
- **TEST-CLEANUP-1**: `entity-created-trigger.isolation.test.ts`'s `afterAll` now also
  deletes `automationExecutions` for the test tenant (was only deleting `outboxEvents`) —
  local re-runs against a non-fresh DB were accumulating execution rows.
- **BULK-TEST-1**: added `apps/api/tests/isolation/bulk-entity-triggers.isolation.test.ts` —
  real-DB tests proving `bulkCreateEntities` writes correctly-redacted `entity.created` rows
  and `bulkUpdateEntities` fires `entity.assigned` only for items whose assignee actually
  changed. The existing `bulk.test.ts` unit tests only checked `db.insert` call counts via
  mocks, not payload shape or queryability.
- **REDACT-INTERNAL**: documented in `redact.ts` why `internal`-sensitivity fields are
  deliberately not redacted from the outbox (automation rules — including webhook actions —
  are admin-only configured, the same trust level that already has direct read access to
  `internal` fields via the entity API).
- **EVENT-SCHEMA-DRIFT**: added a "MUST MATCH" comment in `entity-engine/src/types.ts`
  naming the exact automation-engine schema these local interfaces have to track, plus a new
  isolation test asserting a real `entity.created` outbox row parses cleanly against
  automation-engine's actual `TriggerEventSchema` — catches drift at test time instead of
  in production silently killing every `entity.created` rule.
- **SEED-VALIDATION**: `apps/api/src/routes/automation-rules/schemas.ts`'s `ActionConfigSchema`
  was a loose `{type: enum, config: z.record(unknown)}` — upgraded to a real discriminated
  union with per-type config shapes (`set_field`, `transition`, `webhook` get their actual
  field constraints; the 4 unimplemented `ActionType` variants stay permissive since their
  shape doesn't exist yet). This only protects API-created/updated rules — module seed SQL
  bypasses it entirely (raw INSERT), so also added matching comments in
  `modules/helpdesk/seed/003_automation_rules.sql` and `executor.ts`'s `runAction` pointing
  each at the other, since there's no automated check for the seed-SQL side of this gap.
- **LINT-1**: filed [#141](../../issues/141) for the `pnpm lint` no-op found in the prior
  review round, instead of leaving it as a PROGRESS.md note.

### Verification

- pnpm typecheck: PASS
- pnpm test: PASS (330/330, up from 327)
- pnpm test:isolation: PASS (121/121, up from 118 — 3 new tests: schema-drift-detection,
  bulk-create redaction, bulk-update selective entity.assigned)
- Diff-scoped `eslint --max-warnings=0`: clean

### Next

- #141 needs its own session (adding real `lint` scripts across every `package.json`)
- Everything else from the original #126/#120 session's "Next" list still applies

---

## 2026-07-08 — Hardening #126: entity.created / entity.assigned triggers

### Done

- `packages/entity-engine/src/types.ts`: added local `EntityCreatedEvent`/`EntityAssignedEvent`
  interfaces (plain TS, no cross-package import — entity-engine may only depend on `db` per
  CLAUDE.md's dependency rule; automation-engine already depends on entity-engine, so the
  reverse import would be a cycle). Mirrors how `workflow-engine` defines
  `WorkflowTransitionedEvent` locally rather than importing automation-engine's zod schema.
- `packages/entity-engine/src/engine.ts`: `createEntity`, `updateEntity` (both branches),
  `bulkCreateEntities`, and `bulkUpdateEntities` now write `entity.created`/`entity.assigned`
  rows to `outbox_events` in the same transaction. Closes #126.
  - `entity.assigned` fires on any transition to a new non-null assignee — both
    create-with-assignee and reassignment via update (confirmed with the user; the schema's
    non-nullable `assigneeId` can't represent unassignment, so that case doesn't fire).
  - Flagged with a code comment: this is the first path that makes #120's unbounded
    outbox-routed automation recursion actually reachable (entity.created/assigned rules can
    chain into create/update actions). Not fixed here — #120 stays out of scope.
- **Found and fixed an adjacent bug while writing the Prove-It test**:
  `modules/helpdesk/seed/003_automation_rules.sql`'s "auto-set priority" rule — the exact
  example the consulting review cited as "silently does nothing" — used the wrong action
  shape entirely: `{"type": "set-field", "field": ..., "value": ...}` when the executor's
  `case "set_field"` expects `{"type": "set_field", "config": {"field": ..., "value": ...}}`.
  Without this fix, the rule would have kept silently doing nothing after #126 landed, just
  for a different reason. One-line seed SQL data fix, no schema/API change.
- New isolation test `apps/api/tests/isolation/entity-created-trigger.isolation.test.ts` (5
  tests) — Prove-It Pattern: written first, confirmed failing against unfixed `engine.ts`
  (verified via `git stash` on just that file), confirmed passing after the fix. Proves the
  full chain end-to-end: create an entity → real `outbox_events` row written → handed to
  `executeAutomationRules` exactly as the outbox poller would → the helpdesk-style
  `set_field` rule actually applies the field change. Also covers entity.assigned on create
  and on reassignment, and that re-assigning to the same assignee doesn't re-fire.
- Updated `engine.test.ts`/`bulk.test.ts` mocks and call-count assertions for the new
  `outboxEvents` inserts (2 pre-existing `bulkCreateEntities` assertions needed
  `toHaveBeenCalledTimes(1)` → `(2)`, since bulk create now does one batched insert into
  `entityInstances` plus one batched insert into `outboxEvents`).
- Branch: `fix/PLAT-126-entity-created-triggers`. Plan-lock approved by human before any
  source edit; the `entity.assigned` semantics question (see above) was asked and answered
  before drafting the plan, since the docs didn't disambiguate and the schema can't
  represent every option.

### /security-review finding (fixed before shipping): PII leaves the platform via the new outbox path

The security review flagged that `entity.created`'s outbox payload carried the entity's full,
unredacted field map (`fieldsWithFormulas`) — including `pii`/`financial`-classified fields —
whereas every other secondary store that persists field values (`workflow_events.metadata`,
`admin_audit_log`) redacts them first. Since `entity.created` never fired before this PR, this
was the first path that let raw PII reach a table an admin-configured `webhook` automation
action can forward to an external URL. Adversarially verified as real (not pre-existing —
confirmed the entire outbox-insert block is new in this diff).

Fixed: added `packages/entity-engine/src/redact.ts` (`redactFields`/`buildSensitivityMap`,
same contract as `workflow-engine`'s equivalent, defined locally rather than imported —
same dependency-direction reason as the event types above) and applied it to the `fields`
value in both `createEntity`'s and `bulkCreateEntities`'s outbox payloads before insert.

**While writing the Prove-It test for this fix, found a second, unrelated pre-existing bug**:
`addEntityField` (`packages/entity-engine/src/engine.ts`) accepts a `sensitivity` parameter
and threads it through the whole call chain — including the real API route
(`POST /entity-types/:id/fields`, `apps/api/src/routes/entity-types/fields/create-field.ts`,
already correctly forwarding `input.sensitivity`) — but its DB insert never actually included
the `sensitivity` column, so every custom field ever created via that route silently fell back
to the column default (`'internal'`), regardless of what the caller specified. This meant any
tenant admin who marked a custom field `pii` or `financial` today gets none of the redaction
protection everywhere that classification is supposed to enable — a bigger, platform-wide gap
than the outbox-specific one above. No existing test caught it because the only test touching
`sensitivity` (`audit-hook.test.ts`) mocks field metadata directly rather than exercising the
real insert. One-line fix: added the missing `sensitivity: field.sensitivity` to the insert
`.values()`. The new isolation test's redaction case exercises this real path end-to-end
(creates the field via `addEntityField` with `sensitivity: "pii"`, then asserts redaction),
so it doubles as the regression test for both bugs together.

### /code-review findings (8-angle fan-out) — fixed before shipping

- **`workflow_events.metadata` still leaked raw PII, and my own code comment falsely claimed
  it didn't.** The first redaction fix only covered the new `entity.created` outbox path;
  `createEntity`'s pre-existing `workflow_events` insert (for workflow-attached entities) and
  `updateEntity`'s field-diff (`changed[key] = {old, new}`) both still wrote raw field values.
  Fixed both: `createEntity` now redacts once and reuses the result for both writes;
  `updateEntity`'s diff now computes on **raw** values (redacting first would make every
  pii/financial change look like a no-op, since both sides collapse to the same
  `"[REDACTED]"` string) and redacts only what gets stored.
- **`assignedBy` on `entity.assigned` was computed inconsistently across all 6 call sites** —
  `createEntity` used `actorId ?? createdBy`, `updateEntity`'s two branches and
  `bulkUpdateEntities`'s two branches used `actorId ?? null` (dropping the creator fallback),
  and `bulkCreateEntities` used `createdBy` alone (dropping `actorId` entirely — it never had
  access to it, since the per-row `auditMeta` didn't carry it). Extracted a single
  `resolveAssignedBy(actorId, createdBy)` and used it everywhere, and added `actorId` to
  `bulkCreateEntities`'s parallel `auditMeta` array so the real actor is available per row.
- **`bulkCreateEntities`'s outbox flatMap rebuilt a sensitivity map per row** instead of using
  the function's existing per-type cache (`typeMetaCache`) — hoisted to a `getSensitivityMap`
  helper keyed by `entityTypeId`.
- **`bulkUpdateEntities` did one `outboxEvents` insert per item inside its `Promise.all`**
  instead of batching like `bulkCreateEntities` does — N round trips instead of 1 for a
  100-item bulk update. Collected rows into an array and moved the insert to after
  `Promise.all`.
- **Isolation test file exceeded testing-conventions.md's ~200-line split threshold** (264
  lines, two logical concerns). Split into
  `entity-created-trigger.isolation.test.ts` and `entity-assigned-trigger.isolation.test.ts`.

Declined to fix (documented instead):
- **#120 is now more exploitable, not just reachable**: `entity.created` fires on *every*
  entity creation with zero tenant configuration required, unlike `workflow.transitioned`
  which needs a deliberately configured multi-step workflow to loop. Still out of scope for
  #126 (approved plan boundary), but the severity note is worth carrying into whoever picks
  up #120 next.
- **Helpdesk seed's `WHERE NOT EXISTS` idempotency guard matches on rule name, not content**,
  so tenants that installed the module before this PR's action-shape fix keep the old broken
  payload forever (reseeding doesn't overwrite existing rows, and blindly overwriting could
  destroy a tenant's manual customization). Not fixed: no real tenants are onboarded yet
  (Phase 2 complete, pilot NOT YET per the consulting review), so current-world impact is
  zero; a backfill migration would need a product decision about detecting "still has the
  broken shape" vs. "tenant customized it," not just a mechanical fix.
- **No backfill for `entity_fields` rows already stuck at `sensitivity = 'internal'`** from
  the `addEntityField` bug (fixed above, going forward only) — same reasoning: which existing
  fields were *meant* to be `pii`/`financial` isn't mechanically knowable, needs a tenant/
  product decision, not an automated fix.

### Verification (CI-equivalent local run, same method as PR #135)

- pnpm typecheck: PASS
- pnpm lint: N/A — discovered `pnpm lint` (`turbo run lint`) is a pre-existing repo-wide
  no-op: no package.json anywhere defines a `lint` script, so `turbo run lint` matches
  nothing and trivially succeeds. Confirmed by running `npx eslint` directly on the repo
  root (found real pre-existing errors in untouched files) and then scoped to just this
  PR's changed files (zero errors/warnings). Worth a follow-up issue — flagging, not fixing,
  since it's unrelated to #126 and affects the whole repo/CI, not just this change.
- pnpm test: PASS (327/327, up from 321)
- pnpm test:isolation: PASS (118/118, up from 112 — the new entity-created/entity-assigned
  trigger tests, split across two files)

### Next

1. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
2. Doc fixes from the review: `roadmap-tracker.md` Phase 2 gate wording, `platform-vision.md`
   Mermaid diagram, ADR-004 reference — already shipped in PR #137 (awaiting team merge
   approval as of this session)
3. Remaining hardening items #120, #123, #124, #125, #128, #129
4. #136 — design + implement RLS policies for `entity_types`/`workflows`/`workflow_states`/
   `workflow_transitions`
5. New: file a follow-up issue for the `pnpm lint` no-op discovered above

### Open questions

- None blocking on #126 itself. Flagging for awareness: `bulkCreateEntities`/
  `bulkUpdateEntities` now emit outbox events per existing helpdesk-seed-style rules — any
  tenant that already has module seeds installed will see previously-silent automations
  start firing on the next deploy (not a bug, a behavior change worth a changelog note,
  same category as the entity.created note in the original consulting review).

---

## 2026-07-08 — Post-PR #137 cleanup

### Done

- Fixed two cosmetic residuals flagged in PR #137 review:
  - `docs/reviews/2026-06-29-consulting-review.md` §6 item 12 struck through — finding
    was retracted in §2 (no field type discrepancy exists); open action item was misleading.
  - `docs/sup-docs/week-log.md` 2026-07-08 entry corrected — ADR-004 is now second in the
    CLAUDE.md reference list (not "first"), description uses the softened wording.
- `docs/sup-docs/roadmap-tracker.md` last-updated line updated to include PR #137.

### Verification

- pnpm typecheck: N/A — docs-only
- pnpm lint: N/A — docs-only
- pnpm test: N/A — docs-only
- pnpm test:isolation: N/A — docs-only

### Next

1. #126 — emit `entity.created` / `entity.assigned` to the outbox (core function, currently dead automations)
2. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
3. Remaining hardening items #120, #123, #124, #125, #128, #129

### Open questions

- None blocking.

---

## 2026-07-07 — Hardening #121 / #122: RLS role enforcement

### Done

- `packages/db/src/middleware.ts`: `withTenantContext` now issues `SET LOCAL ROLE app_user`
  before setting the `app.tenant_id` GUC, mirroring `withTenantAndUserContext`. Closes #121.
- `packages/db/src/client.ts`: same fix in `executeRawInTenantContext` (used by module seed SQL).
- `packages/db/migrations/0022_app_user_rls_grants.sql`: grants `app_user` the
  `INSERT/UPDATE/DELETE` it was missing on `entity_types`, `workflows`, `workflow_states`,
  `workflow_transitions` (previously SELECT-only), and `UPDATE` on `tenants` — required
  because workflow-state/transition CRUD, module install/uninstall, and module seed SQL all
  route through `withTenantContext`/`executeRawInTenantContext` and would otherwise start
  failing with permission-denied the moment the role switch landed.
- Un-skipped the three cross-tenant RLS assertions (#122): `entity-engine.isolation.test.ts`,
  `workflow-engine.isolation.test.ts`, and `automation-engine.isolation.test.ts` (this last
  one had no assertion at all — wrote a real direct-SELECT-via-RLS test for it, using
  `withTenantContext` + a query with no explicit tenant filter, matching the other two files).
- Updated `.claude/rules/db-conventions.md` and `.claude/rules/security.md` to describe the
  new role-switch behavior instead of the stale "RLS is bypassed" warning.
- Branch: `fix/PLAT-121-rls-role`. Plan-lock approved by human before any source edit.

### /code-review + /security-review findings (fixed before shipping)

Security review: no findings (traced every call site touching newly-granted tables; all
tenant-scoped writes are JWT-derived and gated by pre-existing ownership checks).

Correctness review surfaced two real bugs, both fixed:

- **`apps/worker/src/tenant-purge.ts:154`** deletes from `dead_letter_events` inside
  `withTenantContext`, but `app_user` only had SELECT+INSERT on that table (migration 0019)
  — the role switch would have broken tenant purge/GDPR deletion with permission-denied for
  any tenant with a dead-lettered job. Added `GRANT DELETE ON dead_letter_events TO app_user`
  to migration 0022.
- **`automation-engine.isolation.test.ts`**'s un-skipped RLS test never seeded a Tenant B
  `automation_executions` row, so it passed vacuously regardless of whether RLS worked.
  Added a `beforeAll` that creates a real Tenant B execution via `executeAutomationRules`,
  plus a sanity-check test proving the row exists (via superuser query) before the RLS test
  proves it's invisible from Tenant A's context.

Also fixed two lower-severity findings: `security.md` pointed only to migration 0019 for
`app_user`'s grants (now also references 0022), and 0022's DOWN MIGRATION block was buried
after 20 lines of rationale instead of near the top like every sibling migration.

Declined one cleanup suggestion: dedup the `SET LOCAL ROLE app_user` line across 3 call
sites into a shared helper — CLAUDE.md's code-style guidance favors 3 similar 2-line blocks
over a premature abstraction, and it matches the file's pre-existing pattern.

Re-ran the full exit condition after fixes: typecheck/lint/test/test:isolation all still
green (see Verification below, numbers reflect the post-fix state).

### New finding — filed as [#136](../../issues/136), not fixed in this PR

`entity_types` and `workflows` have a nullable `tenant_id` but **no RLS policy at all**
(`NULL` tenant_id = system/template rows visible to every tenant); `workflow_states` /
`workflow_transitions` have no `tenant_id` column at all — isolation there depends entirely
on the explicit ownership checks in `packages/workflow-engine` (`assertWorkflowOwned`,
`visibleTo`). This was already true before this PR (RLS was bypassed everywhere via the
superuser connection) — the grant migration does not change or worsen it, since GRANTs are
table-level, not row-level. But it means these four tables have zero second line of defense.
Needs a design decision (schema change) before Phase 3 — tracked in #136.

### Human PR review round (PR #135, reviewed by @PrabhuVijit) — all addressed

PR approved with 2 medium + 3 low non-blocking items; user asked to fix all of them in this
PR rather than defer, since none required large changes:

- **SEC-1** (medium): `GRANT UPDATE ON tenants` was table-wide; column-scoped to
  `GRANT UPDATE (config, updated_at) ON tenants TO app_user` — the only columns the
  module-install/uninstall call site writes. Amended migration 0022 directly (pre-merge,
  never applied to a real environment).
- **TEST-1** (medium): fixing the vacuous-test bug (see above) had removed the only
  assertion that Tenant A's `executeAutomationRules` run doesn't write execution rows
  attributed to Tenant B's rule (the engine-level `WHERE tenant_id` guard, distinct from
  the RLS layer). Restored it as a new test scoped by `ruleId = ruleIdB AND tenantId =
  TENANT_A`.
- **DOCS-1** (low): fixed a markdown line-wrap in `security.md` where prettier had broken
  a sentence mid-backtick-phrase (`` `SET LOCAL ROLE\napp_user` `` at column 0).
- **SUGG-1** (low): filed #136 for the no-RLS tracking issue instead of leaving it as a
  PROGRESS.md note.
- **SUGG-2** (low): added a comment in `executeRawInTenantContext` pointing future module-
  seed authors at the 0022 grant pattern if they hit `permission denied for table X`.

### Verification (CI-equivalent local run — see note below)

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: PASS (321/321 — up from 320: the automation-engine isolation suite grew from
  8 real + 1 no-op skip → 9 real assertions after the initial fix, then +1 more restoring
  the engine-layer WHERE test from the PR review round)
- pnpm test:isolation: PASS (112/112, all three previously-`.skip`'d RLS assertions run for
  real and pass, plus the restored engine-layer assertion)

**How verification was run:** OrbStack was not running at session start. The repo's own
`docker-compose.yml` `postgres` service couldn't bind port 5432 because a pre-existing,
unrelated container (`platform-postgres-1`, same repo directory but an older compose
project name, still running from a prior session) already held it — left untouched, not
part of this PR. Instead of reusing that dev container (which has broader ambient app_user
grants from `docker/postgres/init/001_setup.sql`'s `ALTER DEFAULT PRIVILEGES`, masking any
CI-only grant gaps), spun up plain `postgres:16-alpine` + `redis:7-alpine` containers on
ports 5433/6379 matching `.github/workflows/ci.yml` exactly (same `platform` superuser,
same `platform_test` DB, no init script) so the grant migration was validated against the
same conditions as the real CI gate. Removed both temp containers after the run.

### Next

Per the consulting review (`docs/reviews/2026-06-29-consulting-review.md`) and the
hardening checklist in CLAUDE.md, in order:

1. #126 — emit `entity.created` / `entity.assigned` to the outbox (core function, currently
   dead automations)
2. #127 — guard `setEntityState` / `bulkSetState` (audit/compliance side-door)
3. Doc fixes from the review: `roadmap-tracker.md` Phase 2 gate wording, `platform-vision.md`
   Mermaid diagram, ADR-004 added to CLAUDE.md reference list
4. Remaining hardening items #120, #123, #124, #125, #128, #129
5. #136 — design + implement RLS policies for `entity_types`/`workflows`/`workflow_states`/
   `workflow_transitions` (filed during PR #135 review)

### Open questions

- None blocking.
