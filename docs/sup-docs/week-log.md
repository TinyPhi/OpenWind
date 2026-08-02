# Week-over-Week Progress Log

**Format:** One entry per session or per milestone close. Newest at top.
**Purpose:** Running velocity record for an AI-first dev team. Update this at the start/end of each work session.

---

## 2026-08-02 — #284 PR review fixes (PrabhuVijit)

**Session type:** Review response (same branch, `fix/PLAT-284-modal-a11y-wave2`)
**Issues:** #284 (PR #298)

### Completed this session

- Addressed PrabhuVijit's PR #298 review: all ~20 custom `<DialogClose asChild>` close buttons
  (`<button className="modal-close">×</button>`) were missing `aria-label="Close"` — screen
  readers announced the `×` glyph literally instead of "Close". Added to all of them across
  `workflows/detail.tsx`, `record-detail.tsx`, `entity-types/*`, `instance-detail.tsx` (blocking).
- Also added the non-blocking `type="button"` suggestion to the same 14 buttons that were missing
  it (some already had it).
- Filed **#304** for the two remaining non-blocking suggestions (a shared `DIALOG_CONTENT_RESET`
  constant for the ~20-times-duplicated style-reset block, and converting `modules.tsx`'s two
  modals from conditional-mount to the controlled `open`/`onOpenChange` pattern used everywhere
  else) — the second one touches ~14 `previewTarget.`/`forkTarget.` references and deserves its
  own careful pass rather than being rushed into this response.

### Verification

- `pnpm --filter @platform/admin-ui typecheck && lint && test` — green (90/90 tests).

---

## 2026-08-02 — #284 a11y wave 2: migrate remaining modals to Dialog/AlertDialog

**Session type:** Frontend a11y (Plan → Code → Review → Docs → Ship)
**Branch:** `fix/PLAT-284-modal-a11y-wave2`
**Issues:** #284

### Completed this session

- Migrated 24 of the ~27 remaining single-instance modals (wave 1, #198/PR #285, consolidated
  the 2 duplicated patterns) from hand-rolled `.modal-overlay`/`.modal` divs to `@platform/ui`'s
  `Dialog`/`AlertDialog`, using the exact style-reset technique `transition-modal.tsx` already
  established — zero visual change, real `role="dialog"`/`aria-modal`/focus-trap gained. Split
  across 4 files: `workflows/detail.tsx` (7), `customer/record-detail.tsx` (8),
  `workflow-canvas.tsx` + `modules.tsx` (4), `entity-types/*` + `record-list.tsx` (5).
- Deferred, unchanged: `workflow-canvas.tsx`'s `TransitionPanel` (a slide-in side panel, not a
  true modal) and `record-detail.tsx`'s access-denied overlay (a full-page state) — both
  explicitly flagged in the issue as needing separate manual judgment.
- De-duplicated a near-duplicate "Request access?" confirmation that had been split into two
  copies (one standalone modal, one embedded inside the access-denied overlay) purely to dodge a
  z-index/stacking bug — now that the standalone copy is a portal-based `Dialog`, the embedded
  copy was redundant and removed.
- **Found and fixed a real bug while doing this**: `packages/ui`'s `DialogContent` unconditionally
  renders its own "×" close button, even when a modal's own markup already supplies one —
  producing two close affordances. This was already live in production via `transition-modal.tsx`
  (wave 1, PR #285, 2 shipped instances) but wave 2 was about to propagate it to ~22 more. Added
  an opt-out `showCloseButton?: boolean` prop (default `true`, preserving existing behavior for
  callers with no close control of their own) and set it `false` on every migrated modal that has
  its own.

### Verification

- `pnpm typecheck && pnpm lint` — green repo-wide.
- `pnpm --filter @platform/ui test` — 10/10 pass (this branch predates #199's Button/IconButton
  work, so only `dialog`/`alert-dialog` tests exist here; added a new test for `showCloseButton`).
- `pnpm --filter @platform/admin-ui test` — 90/90 pass, no regressions.
- Manual diff review of all 4 migration groups plus the `showCloseButton` fix.
- No full-browser visual check possible in this sandbox (same environment gap as the #199
  session) — substituted with jsdom component tests + manual diff review.

### Next

- `TransitionPanel` and the access-denied overlay remain open for a future, separately-scoped
  manual-judgment pass.
## 2026-08-01 — #196 perf scale-risk backlog: closed

**Session type:** Investigation / issue triage (no source changes)
**Issues:** #196 (closed), #296 (filed)

### Completed this session

- Re-verified all 4 grouped sub-findings in #196 against current code (post the recent
  security-hardening PR batch, #279–#294), rather than trusting the 2026-07-31 investigation
  comment at face value:
  - Cross-instance cache invalidation — confirmed still doesn't reproduce.
    `schema-cache.ts`'s `invalidateSchemaCache` uses cursor-based `redis.scan` + `del`, not the
    blocking `redis.keys()` issue #4 separately tracks; `engine.ts`'s three `Map` caches are all
    function-local (recreated per call), not persistent cross-replica state.
  - `ts_rank` OFFSET pagination cliff — confirmed still doesn't reproduce, zero `OFFSET`/
    `.offset(` usage under `entity-engine/src`.
  - `bulkUpdateEntities` N+1 — already fixed via PR #271.
  - Connection pool ceiling (`DATABASE_POOL_MAX=10`) — genuinely not resolvable by code-reading;
    needs a real concurrency target + load test. Split into its own tracked issue, **#296**, per
    #196's own "suggested next step" (split once any item is confirmed/scoped).
- Closed #196 with the re-verification recorded as a comment.

### Next

- #296 stays open until a load-test session with a concrete concurrent-tenant target is run —
  matches CLAUDE.md's existing "deferred until load testing" gate for adjacent schema-cache work.

---

## 2026-08-01 — security group G: automation engine hardening + abmish review fixes

**Session type:** Security hardening (Plan → Code → Review → Docs → Ship)
**Branch:** `fix/PLAT-security-group-g`
**PR:** #293
**Issues:** #245, #228, #258, #256, #259, #257
**Skipped:** #246, #248, #250 — blocked on issue #2 (SSRF/PII), require human review

### Completed this session

- **#245** Fail-closed circuit breaker — throw `CIRCUIT_BREAKER_UNAVAILABLE` when redis is
  undefined instead of silently bypassing; running automation without a circuit breaker is worse
  than refusing to run. The executor catches this per-rule and marks the execution `failed`.
- **#228** Deterministic notify IDs — SHA-256 of `(tenantId, ruleId, jobEventId, recipientId)`
  formatted as a UUID v4-like string, plus `onConflictDoNothing` on both DB inserts. `jobEventId`
  is the outbox event row ID (= BullMQ `jobId`), which is constant across all retry attempts —
  not `execRow.id` which is freshly generated on each call (abmish finding #1). Threaded through
  `executeAutomationRules` → `runAction` → `executeNotifyAction` and through
  `executeTransitionAction`'s recursive call.
- **#258** Removed `OutboxDepthSchema.passthrough()` — Zod's default strip mode is correct.
- **#256** Unknown action type now throws `UNKNOWN_ACTION_TYPE` instead of silently no-op'ing.
  `connector.action` is now an explicit case that logs and no-ops gracefully — preserving
  existing stored rules without tripping the circuit breaker (abmish finding #4).
- **#259** Removed `script` action type from executor switch and API schemas.
- **#257** Per-trigger-type `triggerConfig` validation: partial PATCH now fetches the existing
  rule from DB to validate the config/type pair when only one half is patched (abmish finding #2).
  `TRIGGER_CONFIG_SCHEMAS` changed from `Partial<Record<...>>` to `Record<...>` for compile-time
  exhaustiveness (abmish finding #5). Wizard UI field names (`recipients`, `channels`, `message`)
  preserved in `NotifyConfigSchema` so they survive Zod's default strip (abmish finding #3).

### Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test (automation-engine unit, 64/64): PASS
- pnpm test (automation-rules routes, 13/13): PASS
- pnpm test:isolation: requires Docker stack — deferred to CI

---

## 2026-07-31 — #191–#202 batch triage: 5 PRs (backup/DR, e2e harness, field widgets, a11y modals wave 1, confirm/alert dialog)

**Session type:** Backlog triage + fixes (Plan → Code → Review → Docs → Ship, one plan-lock/PR per issue)
**Branches:** `fix/PLAT-201-confirm-alert-dialog`, `fix/PLAT-198-a11y-modals`,
`chore/PLAT-192-backup-runbook`, `test/PLAT-194-e2e-harness-mvp`, `feat/PLAT-197-field-type-widgets`
**Issues:** #201, #198, #192, #194, #197 (all part of the #191–#202 second consulting-review batch)

### Completed this session

- **#201** (PR #282): replaced native `confirm()`/`alert()` at 8 call sites with a shared
  `GlobalAlertDialog` (window `CustomEvent` controller, mirrors the existing
  `global-error-banner.tsx` pattern) built on `@platform/ui`'s `AlertDialog` primitive. Found and
  fixed a double-fire bug along the way: `AlertDialogCancel` auto-triggers `onOpenChange(false)`,
  so an explicit `onClick` alongside it called `onCancel` twice.
- **#198** (PR #285, wave 1 of N): consolidated the first 2 duplicated modal patterns —
  `ConfirmDeleteDialog` (replaces 5 hand-rolled copies) and `TransitionModal` (replaces 2
  byte-for-byte-identical ~161-line components). Filed **#284** documenting the remaining ~27
  single-instance modals as a follow-up rather than scope-creeping this PR.
- **#192** (PR #286): finished the backup runbook — verified end-to-end against the real stack
  (uploaded a test file to MinIO, ran the backup, confirmed checksum match; restored the Postgres
  dump into a scratch DB, confirmed table/row counts matched source exactly). Documented scope
  (Postgres + MinIO backed up; Redis/Mongo deliberately not) in `docs/local-setup.md`.
- **#194** (PR #287): stood up `tests/e2e/` with one real MVP flow (module install →
  view-config seeding), and — in the process — discovered every existing "integration" test in
  this repo mocks `@platform/auth` entirely, so no test had ever exercised the real
  `requireAuth`/`requireRole` chain. This one uses a real `api_keys` DB row and real HTTP auth.
  Also fixed a real (if narrow) gap while here: `apps/api/vitest.config.ts`'s module-alias map was
  missing `@platform/redis`, the actual root cause of an unrelated CJS/ESM resolution failure.
- **#197** (PR #288): consolidated the 4 duplicated `FieldInput` implementations into one shared
  component; added real widgets for `user_ref` (reuses the existing `UserPicker`) and `entity_ref`
  (new searchable picker, resolves `config.target_entity_type` via `useEntityTypes()`); `formula`/
  `lookup` render read-only (confirmed both are computed server-side). `file`/`files` deferred as
  **#289** — the upload API's required `moduleSlug` param doesn't fit a generic, page-agnostic
  component.
- **#149** and **#218** closed earlier in this session (PRs #269, #270); **#196** investigated —
  2 of 4 sub-findings don't reproduce against current code, 1 fixed via PR #271.

### Verification

- pnpm typecheck: PASS (repo-wide, all 40 tasks)
- pnpm lint: PASS (repo-wide, `--max-warnings=0`)
- pnpm test: PASS — 589/596, 6 skipped; 2 pre-existing failures (`quarantine-flow.test.ts`,
  `upload-flow.test.ts`, both Redis `ECONNREFUSED` — this repo's dev compose doesn't map Redis to
  a host port — confirmed pre-existing, not introduced by this session's changes)
- pnpm test:isolation: PASS (33/33 files, 217/217 tests)
- `vite build`: clean production build for admin-ui after each UI change

### Next

- #199 (`packages/ui` hollow) and #200 (zero i18n) remain untouched — still open, unassigned.
- #284 (remaining ~27 modals) and #289 (`file`/`files` widgets) filed as explicit follow-ups.
- #196 left open pending a decision on the connection-pool-sizing sub-finding (the only one of the
  4 not fully resolved or dismissed).
- 5 PRs open awaiting human review: #282, #285, #286, #287, #288.

### Open questions

- None blocking. All 5 PRs document their scope decisions (deferred file/files, modal wave 1,
  pool-sizing) directly in their PR bodies / filed follow-up issues rather than leaving them
  implicit.

---

## 2026-07-31 — security group B: four critical API access control fixes

**Session type:** Security hardening (Plan → Code → Review → Docs → Ship)
**Branch:** `fix/PLAT-security-hardening`
**Issues:** #225, #223, #229, #231
**Spec:** `docs/specs/security-group-b-api-access-control.md`

### Completed this session

- **#225** (critical): `viewConfigsRouter` was registered before `adminRouter` in `app.ts` —
  Hono first-match wins, so `GET /admin/view-configs/:entityType` was handled by the router that
  only had `requireAuth()` (no `requireRole()`), making it readable by any authenticated user.
  Fixed by adding `requireRole("agent", "admin")` to the GET handler directly.
- **#223** (critical): `POST /api-keys` accepted arbitrary `scopes` including `"superadmin"` from
  an `admin`-role caller. Fixed by validating requested scopes are a subset of the creator's own
  JWT roles before inserting the key.
- **#229** (critical): `POST /entities` and `POST /entities/bulk` accepted `createdBy` from the
  request body. Any `user`-role caller could attribute an entity to another user and gain implicit
  `read_write` access via the `createdBy === userId` access shortcut. Fixed by stripping `createdBy`
  from both schemas; the authenticated `userId` is now always used.
- **#231** (critical): `GET/PATCH /admin/platform-settings` required only `requireRole("admin")`,
  but `platform_settings` is a global singleton (not tenant-scoped). Any tenant admin could
  toggle the outbound notifications kill-switch platform-wide. Fixed to `requireRole("superadmin")`.
  Updated existing isolation test to match.

**Tests:** 23 new unit tests across 4 new test files; existing isolation test updated.
**Result:** 347/347 unit tests passing; typecheck + lint clean.

---

## 2026-07-31 — Security Group C: file route hardening (#224, #235, #239, #240, #241)

**Session type:** Security fix (Plan → Code → Review → Docs → Ship)
**Branch:** `fix/PLAT-security-group-c`
**Issues:** #224, #235, #239, #240, #241

### Completed this session

- **#224 / #239** (`download.ts`, `status.ts`): Unbound files (entityId = null) skipped all ACL
  checks — any authenticated tenant member who knew a fileId could obtain a presigned download URL
  for another user's unattached file. Added uploader-ownership check (`uploadedBy === userId`) for
  files not yet bound to an entity; admin/agent roles bypass as expected.
- **#235** (`delete.ts`): `DELETE /files/:id` called `deleteFile(db, ...)` with the raw module-level
  `db` handle, bypassing `withTenantContext`. RLS second layer (ADR-001) was absent on the only
  mutating file route. Wrapped in `withTenantContext`.
- **#240** (`packages/files/src/index.ts` — `getDownloadUrl`): SVG files served with
  `Content-Disposition: inline` are executed as JavaScript in the browser's page origin — stored-XSS
  via crafted SVG upload. Force attachment regardless of the caller's inline flag when
  `mimeType === 'image/svg+xml'`.
- **#241** (`packages/files/src/index.ts` — `getDownloadUrl`): Raw `originalName` embedded in
  `Content-Disposition` allowed header injection (`\r\n`), early value termination (`"`), and
  Unicode bidi-override spoofing. Sanitized the ASCII fallback and added RFC 5987 `filename*`
  encoding for Unicode filenames.

**Tests:** 18 new tests across `files.test.ts`, `status.test.ts`, `packages/files/src/index.test.ts`.
332/332 unit tests passing. Typecheck + lint clean.

## 2026-07-31 — Group E: withTenantContext gaps in worker + routes (#243 #244 #254 #234)

**Session type:** Security hardening (Plan → Code → Review → Docs → Ship)
**Branch:** `fix/PLAT-security-group-e`
**Spec:** `docs/specs/group-e-withtenant-context-gaps.md`

### Completed this session

- **#243 sla-breacher bare db**: Both the main processor and the dead-letter failed handler
  replaced `db.transaction()` + manual `set_config` with `withTenantContext(tenantId, tx => ...)`.
  RLS second layer now enforced on `outbox_events`, `entity_instances`, and `dead_letter_events`.
- **#244 sla-scheduler no role switch**: The dead-letter loop inside `tick()` already used
  `set_config` but not `SET LOCAL ROLE app_user`. Added `await tx.execute(sql\`SET LOCAL ROLE app_user\`)`before each tenant's`set_config`call. Cannot use`withTenantContext`here because the outer`db.transaction()` with FOR UPDATE SKIP LOCKED must remain a single atomic transaction.
- **#254 notification prefs bare db**: `apps/api/src/routes/preferences/notifications.ts` — both
  GET and PATCH replaced bare `db` calls with `withTenantContext`.
- **#234 entity-type GET/list routes bare db**: `apps/api/src/routes/entity-types/get.ts` and
  `list.ts` both updated to route through `withTenantContext`.
- Tests: `sla-breacher.test.ts` mock structure replaced (`db.transaction` → `withTenantContext`),
  assertions updated. `sla-scheduler.test.ts` updated to assert two execute calls per tenant
  (SET LOCAL ROLE + set_config). New test files: `preferences/notifications.test.ts`,
  `entity-types/get.test.ts`, `entity-types/list.test.ts`.

### Verification

- pnpm typecheck: PASS (all packages)
- pnpm lint: PASS
- pnpm test: PASS — 97 worker unit tests, 337 API unit tests; pre-existing integration/isolation
  failures (Docker not running) are unrelated to this diff
- pnpm test:isolation: pending Docker stack

### Next

- Open PR for `fix/PLAT-security-group-e`
- PRs #279 (Group B), #280 (Group C), #281 (Group A) still open awaiting CI + human review

### Open questions

- None

---

## 2026-07-31 — #195 closed: post-auth tenant-scoped rate limiting

**Session type:** Investigation + bug fix (Plan → Code → Review → Docs → Ship)
**Branch:** `fix/PLAT-195-tenant-rate-limit`
**Issue:** #195
**Spec:** `docs/specs/tenant-scoped-rate-limit-195.md`

### Completed this session

- Investigated the `loadEntityType()` defense-in-depth finding surfaced during #191's review
  (missing explicit tenant filter, relying solely on RLS). Confirmed it's not currently
  exploitable — RLS on `entity_types` since ADR-007 already blocks the cross-tenant case for every
  real call path — but is a genuine violation of this repo's "two layers, always" rule. Filed as
  **#220** rather than silently absorbed, so it doesn't rot unfiled.
- **#195**: `apps/api`'s pre-auth rate-limit middleware ran before `requireAuth()`, so its
  "prefer verified auth" branch was permanently dead code; its fallback decoded (never verified) a
  bearer token's `org`/`sub` claim and bucketed on it, letting a client evade its limit entirely by
  varying an unverified claim per request.
  - Pre-auth stage simplified to key strictly on client IP — no token content read at all.
  - New post-auth, tenant-scoped stage added inside `requireAuth()` (`@platform/auth`), both the
    JWT and API-key paths, keyed on the verified `auth.tenantId` — unforgeable by construction.
    100 req/min default (`RATE_LIMIT_TENANT_PER_MIN`, matches `security.md`'s documented default).
  - Both stages share one sliding-window Redis implementation, moved to `@platform/redis`
    (`packages/redis/src/rate-limit.ts`) rather than duplicated.
  - **Correctness fix found via runtime testing, not assumed**: the original design assumed
    "fails open on Redis error" the way the pre-auth stage's own code comment implied — but
    verifying against this repo's actual Redis container (no host port mapping by design) showed
    ioredis queues commands while disconnected rather than rejecting fast, so an unreachable Redis
    would hang a request for many seconds instead of failing open. Fixed by wrapping the shared
    `checkRateLimit` in a bounded 250ms timeout that always resolves (never throws), verified with
    a real hung-pipeline test that measures elapsed time.
- Prove-It confirmed throughout: new tests in `rate-limit.test.ts` (both `apps/api` and
  `@platform/redis`) and `middleware.test.ts` fail against the pre-fix code (checked via
  `git stash`), pass after.

### Verification

- pnpm typecheck: PASS (all 28 packages)
- pnpm lint: PASS
- pnpm test: 2 pre-existing failures (`quarantine-flow.test.ts`, `upload-flow.test.ts` — both
  ioredis "Connection is closed" against a Redis this host can't reach), confirmed pre-existing via
  `git stash` comparison against the base commit; unrelated files, not touched by this diff
- pnpm test:isolation: PASS (26/26 files, 185/185 tests, including 2 extended with new cases)

### Next

- #191–#202 (second consulting-review batch, filed 2026-07-24) still mostly open/unassigned.
- #218 (create_entity recursion-depth gap) and #220 (loadEntityType tenant-filter gap) both need
  a human-approved plan-lock before pickup — both change an entity-engine package contract.

### Open questions

- None blocking. Flagged in the spec: the post-auth limit is a flat 100/min regardless of route —
  route-class-aware post-auth limits are a possible follow-up if that proves too coarse in practice.

---

## 2026-07-30 — #191 closed: automation `assign`/`create_entity` actions wired up

**Session type:** Bug fix (Plan → Code → Review → Docs → Ship)
**Branch:** `fix/PLAT-191-automation-assign-create-entity`
**Issue:** #191

### Completed this session

- `packages/automation-engine/src/executor.ts`'s `runAction` switch had no case for `assign` or
  `create_entity` — both were declared in the `ActionType` union (selectable in the no-code
  automation builder, usable in module seed SQL) but silently no-opped. Added:
  - `actions/assign.ts` — calls `updateEntity({ assignedTo })`, mirroring `set-field.ts`'s
    instanceId-resolution and depth-threading pattern.
  - `actions/create-entity.ts` — calls `createEntity` with a configured `entityTypeId`/`fields`.
- Replaced the two `Record<string, unknown>` placeholder shapes in `ActionConfig` (types.ts) and
  `ActionConfigSchema` (apps/api's automation-rules/schemas.ts) with real typed/Zod shapes now
  that they're implemented.
- Prove-It: added failing tests first (confirmed via `git stash` on the implementation files that
  they fail on pre-fix code), then implemented, then confirmed green.
- New isolation test (`automation-assign-create-entity.isolation.test.ts`) runs both actions
  end-to-end through a real automation rule against Postgres.
- **Filed #218 as a follow-up, not fixed here:** wiring up `create_entity` makes a previously
  theoretical gap live — `buildEntityCreatedPayload` (entity-engine) has no `depth` parameter,
  unlike `buildEntityAssignedPayload` (which #120/PR#139 fixed), so a self-triggering
  `create_entity` rule recurses unbounded across the outbox hop instead of hitting `MAX_DEPTH`.
  Fixing it changes `CreateEntityInput`'s shape — an entity-engine API change out of #191's scope.
  Not blocking on it: `create_entity` ships inert in every existing module seed today.

### Verification

- pnpm typecheck: PASS (all 28 packages, after rebuilding several packages' stale `dist/` —
  pre-existing staleness from the 58-commit pull earlier this session, not caused by this diff)
- pnpm lint: PASS
- pnpm test: 10 pre-existing failures in `modules.test.ts`/`upload-flow.test.ts`/
  `view-configs.test.ts` (freshly-created local `platform_test` DB missing seed data, and Redis
  unreachable from host per the port-mapping removal) — confirmed pre-existing via `git stash`
  comparison against the base commit; unrelated files, not touched by this diff
- pnpm test:isolation: PASS (27/27 files, 186/186 tests, including the 2 new ones)

### Next

- #191–#202 (second consulting-review batch, filed 2026-07-24) otherwise remain open and
  unassigned — worth a triage session before they rot the way #191 itself sat for 6 days.
- #218 (create_entity recursion-depth gap) needs a human-approved plan-lock before pickup, since
  it changes an entity-engine package contract.

### Open questions

- None blocking.

---

## 2026-07-31 — #220 fixed: `loadEntityType` explicit tenant filter

**Session type:** Small security-hardening fix, branch `fix/PLAT-220-load-entity-type-tenant-filter`
**Issue closed (pending merge):** #220 — `loadEntityType` had no explicit tenant filter, relying on RLS alone (defense-in-depth gap flagged during #191 review, not exploitable today)

**What landed:**

- `loadEntityType` (`packages/entity-engine/src/engine.ts`) gained a `tenantId` param + the same `or(isNull(tenantId), eq(tenantId, …))` filter `loadEntityFields` already used
- All 9 call sites updated to pass the `tenantId` already in scope at each — no new parameter threading, no public API change (helper is unexported)
- New isolation test (`load-entity-type-tenant-filter.isolation.test.ts`) proves the explicit filter blocks cross-tenant access using a bare `db` connection (no `withTenantContext`), isolating this layer from RLS
- Full spec + task-plan pair in `docs/specs/entity-engine-load-entity-type-tenant-filter-220{,-tasks}.md`

**Verification:** typecheck 40/40, lint 40/40 (0 warnings), entity-engine unit tests 189/189, isolation tests 210/210 (31 files). Full `pnpm test` has pre-existing unrelated failures (Redis unreachable in host-mode runs per this repo's `docker-compose.yml`; already-tracked #149 flake) — logged in the spec's §B, not caused by this change.

---

## 2026-07-29 — PRs #211, #212, #214 merged; Phase 2 hardening complete

**Session type:** PR review + merge (three PRs)
**PRs merged:** #211 (feat/PLAT-notification-hub-core — Tushar Sharma), #212 (feat/PLAT-notification-hub-followups — Tushar Sharma), #214 (fix/PLAT-remove-portal-from-docker-matrix — PrabhuVijit)
**Issues closed:** #125 (`notify` action stub wired end-to-end)

**What landed in #211 (notification hub core):**

- New tables: `notifications`, `notification_recipients` — RLS-enabled, `app_user`-granted, tenant-scoped, idempotent via unique `(notification_id, user_id)` index
- New API routes: `GET /notifications` (keyset-paginated inbox), `POST /notifications/:id/read`, `POST /notifications/mark-all-read` — all scoped to caller's own auth-derived `tenantId`/`userId`
- WebSocket endpoint `/ws/notifications` — JWT via `?token=` query param, Redis pub/sub fan-out across worker processes
- 6 system-triggered notification types wired end-to-end: `entity.assigned`, `comment.mentioned`, `access.granted`, `access.revoked`, `workflow.sla_breached`, `system.error` — plus `automation.notify` tenant-authored path
- Pluggable outbound seam (`notification-outbound-worker.ts`) — `NOTIFICATION_SERVICE_URL` env; no-ops cleanly if not configured
- `zitadel-management.ts` relocated from `apps/api/src/lib` to `packages/auth/src` so `apps/worker` can reach `getUserById`
- `apps/portal` removed (stale; `apps/admin-ui` serves both agent and customer users)
- 10-case isolation test suite for new tables; path-traversal regression test for `markNotificationRead`

**Review rounds for #211:** 3 rounds (two CHANGES_REQUESTED, one APPROVE). Main findings:

- Round 1 (pre-CodeQL): `URL`-constructor origin guard added to `api.ts` (`doFetch`, `fetchRawWithAuth`)
- Round 2: Two tenant-isolation blockers — missing `eq(notifications.tenantId, tenantId)` in outbound worker "sent"/"failed" UPDATEs; `workflow.sla_breached` using bare `db` without `withTenantContext`; both fixed. Tests added for outbound worker. `encodeURIComponent(id)` path-traversal fix in `markNotificationRead`.
- Round 3: All blockers resolved — approved

**What landed in #212 (notification hub followups):**

- **Global outbound-notifications kill switch** — single-row `platform_settings` table (migration `0044`), `GET`/`PATCH /admin/platform-settings` admin-role-gated; both outbound-enqueue call sites gated (`notify.ts`, `notification-worker.ts`); fails closed on DB error
- **Zitadel M2M auth for outbound handoff** — `notification-outbound-auth.ts` acquires a service-account token before POSTing to `NOTIFICATION_SERVICE_URL`; token cached until 60 s before expiry
- **Auto-logout on inactivity** — `useIdleLogout` hook (5 min default, resets on user activity); wired in `App.tsx`
- **Settings page tabs redesign** — outbound kill switch toggle lives under new Settings → Notifications tab
- **Role-gate isolation tests** for `/admin/platform-settings`
- Migration renumber fix: `0043` → `0044` (conflict with notification tables migration from #211)

**What landed in #214 (CI fix):**

- Removed stale `portal` from Docker build matrix — `apps/portal` no longer exists; its presence caused the entire matrix job group to fail on every push to `main`
- Added `fail-fast: false` to prevent one matrix leg failure from cancelling the others

**Hardening status:**

| Backlog               | Status                                                           |
| --------------------- | ---------------------------------------------------------------- |
| Pre-Phase 3 hardening | ✅ **Complete** — all items closed (#121–#129, #141, #136, #125) |

---

## 2026-07-25 — global outbound-notifications kill switch (dev session)

**Session type:** New feature (not on the tracked #120–#129 backlog)
**Branch:** `tushar` (merged `notification` + `workflow` branches in first)

### Completed this session

- Merged `notification` (fast-forward) and `workflow` (clean 3-way merge, no
  conflicts) branches into `tushar`; pushed to origin.
- **Global outbound-notifications kill switch**
  (`docs/specs/outbound-notifications-kill-switch.md`): a single
  platform-wide toggle, admin-only, on the Settings page, to stop the
  outbound email/SMS/WhatsApp handoff without touching in-app delivery.
  Deliberately **not per-tenant** — the failure mode (external delivery
  service down/misbehaving) affects every tenant identically.
  - New single-row `platform_settings` table (migration `0043`), no
    tenant_id/RLS — a platform-operator concern, same pattern as
    `modules.isVisible`.
  - `isOutboundNotificationsEnabled()` fails **closed** (disabled) on any DB
    error or missing row — the switch exists specifically to stop outbound
    traffic during an incident, so erring toward "don't send" is safer.
  - `GET`/`PATCH /admin/platform-settings`, admin-role-gated.
  - Both outbound-enqueue call sites gated:
    `packages/automation-engine/src/actions/notify.ts` and
    `apps/worker/src/notification-worker.ts`.
  - Settings-page toggle, same optimistic-update-with-revert pattern as the
    existing module-visibility toggle.

### Verification

- pnpm typecheck: PASS (packages/db, automation-engine, worker, api, admin-ui)
- pnpm test: PASS for all touched suites (notify.test.ts,
  notification-worker.test.ts, notifications isolation tests). Full
  `apps/api` suite has 4 pre-existing failures unrelated to this feature
  (file quarantine/AV-scan and module-seed tests) — not introduced by this
  change, not touched by its scope.
- pnpm lint: N/A — repo-wide no-op per #141.
- Migrations applied to both the `platform` dev DB and the `platform_test`
  DB used by `apps/api`'s test suite.

### Open questions

- None blocking. The 4 pre-existing `apps/api` test failures (quarantine/
  upload/modules seed) are worth a follow-up session — not caused by this
  work but discovered while re-verifying the full suite.

---

## 2026-07-24 — Docs/config hygiene bundle: #193, #203, #204 closed

**Session type:** Docs + config (mechanical fixes, no code)
**Branch:** `chore/PLAT-193-docs-config-hygiene`
**Spec:** `docs/specs/docs-config-hygiene-193-203-204.md`

### Completed this session

- **#203** — `architecture-brief.md`'s module map was stale: it referenced a `@platform/search`
  package that doesn't exist under `packages/`, and listed `inventory` (never built) instead of
  `tender` (the platform's actual, shipped 8th module). Removed the dead package reference,
  swapped `inventory` → `tender`, and added a `Category` column citing ADR-005 (`core` for the
  original 7, `optional` for `tender`).
- **#204** — `docs/local-setup.md` didn't mention OpenBao or MinIO at all despite both being real,
  uncommented `docker-compose.yml` services. Added a full section: env vars, first-run init
  steps, and the PR #178 idempotent-retry gotcha (`openbao-init`'s "transit engine already
  enabled" message on repeat `docker compose up` is expected, not a failure). Root `SETUP.md`
  duplicated and was staler than `docs/local-setup.md`; since `README.md` links the root path
  directly, turned it into a one-line pointer rather than deleting it outright.
- **#193** — all 10 non-core `docker-compose.yml` images were pinned to floating `:latest`.
  Pulled each fresh and pinned to its actual resolved digest (a freeze, not an upgrade) —
  `openbao`/`openbao-init` share one digest as required. Found along the way that the three
  `novu-*` images have already drifted apart upstream (api/worker rebuilt 2026-07-08, web not
  since 2025-03-21) — pinned each to its real current state and documented the drift in
  `local-setup.md` rather than forcing an artificial match. Added a bump policy note (deliberate,
  own commit, never silent).
- Went through this repo's full Plan → Code → Review flow for all three: spec written and
  stress-tested (`/spec-review` found two blockers — T4's wording risked upgrading instead of
  freezing versions, and the two `openbao` lines had no parity requirement — both fixed before
  implementation), plan-lock drafted and human-approved, implementation verified against every
  acceptance criterion (grep checks, `docker compose config`, `docker compose pull`, README link
  check), `pnpm typecheck`/`lint` confirmed green. `pnpm test` has one pre-existing failure
  (`@platform/auth`, missing `platform_test` DB) confirmed via `git stash` to exist identically
  on the base commit — not a regression from this change.
- `docs/sup-docs/roadmap-tracker.md` deliberately **not** touched this session: it's already
  substantially owned by in-flight PR #189, which predates and doesn't cover these three issues —
  editing it here would risk an avoidable merge conflict for no scorecard benefit (none of
  #193/#203/#204 are phase-tracked items).

### Verification

- pnpm typecheck: PASS
- pnpm lint: PASS
- pnpm test: 1 pre-existing, unrelated failure (`@platform/auth` — missing `platform_test` DB),
  confirmed pre-existing via `git stash` comparison against the base commit
- pnpm test:isolation: N/A — blocked by the same missing DB, and not triggered anyway (no new
  tables/routes in this diff)

### Next

- Open the PR for `chore/PLAT-193-docs-config-hygiene`, closing #193/#203/#204.
- Once PR #189 merges, its roadmap-tracker.md rewrite will still need a follow-up mention of
  these three closures if the scorecard is meant to reflect every closed issue.

## 2026-07-24 — Hardening backlog closeout: #167/#160/#170/#129/#176 closed, RLS/ADR-007 + nit-bug batches in review, docs audit

**Session type:** Mixed (parallel backlog work + guardrail infra fix + full docs audit)
**Branches:** `fix/PLAT-167-grant-access-consistency`, `fix/PLAT-160-state-validation`,
`fix/PLAT-176-hook-worktree-per-branch-state`, `chore/PLAT-128-openbao-init-idempotent`,
`chore/PLAT-batch2-nit-fixes`, `docs/PLAT-*` (this cleanup)

### Completed this session

- **#167** (`grant-access.ts` should accept workflow-admin callers) — closed via PR #179. Ported
  the `isPrivileged || isRecordWorkflowAdmin` pattern already used by the three sibling ACL
  routes; deliberately no `isOwner` path (direct-grant stays admin/workflow-admin-only per
  `resolve-access-request.ts`'s own rationale). Adversarial review found no issues in the core
  logic; strengthened unit-test call-argument assertions per its one suggestion.
- **#160** (`setEntityState`/`bulkSetState` don't validate target state) — closed via PR #180.
  Mirrors `updateEntity`'s existing `workflow_states` check, including the child-ticket
  fixed-state-list branch. Adversarial review caught two real bugs before ship: a duplicate-id
  index-collapse bug in `bulkSetState`'s error reporting, and a missing child-ticket check
  (children inherit their parent's `workflowId`, so without this they'd validate against the
  parent's full workflow instead of the fixed open/in-progress/closed set) — both fixed.
- **#176** (guardrail hooks: shared state clobbers across branches, `edit-gate` silently bypasses
  worktrees) — closed via PR #177. New `.claude/hooks/lib/context.js`; state now keyed per-branch
  (`.claude/state/<kind>/<branch-slug>.json`); `edit-gate`/`commit-gate`/`ship-cleanup` resolve
  the actual worktree a tool call targets instead of the hook's own inherited cwd;
  `approval-gate`/`verify-stop` (no anchor available from a chat prompt or Stop event) scan all
  linked worktrees and report ambiguity rather than guessing. Caught and fixed a real bug during
  verification: a raw-vs-trimmed hash mismatch between `write-ship-marker.sh` and
  `commit-gate.sh`/`approval-gate.sh` that would have made every real `approve-ship` fail.
- **#128 follow-up** (openbao-init idempotency, flagged in PR #173's review) — closed via a
  standalone PR, verified live against two consecutive `docker compose up` runs.
- **#170** (`installModule` rename dead for non-templated seeds), **#129** (worker health
  endpoint) — both already closed 2026-07-24 via PRs #174/#175 (see below, same day, prior
  session block); reconciled into this backlog view.
- **ADR-005** (core/optional module category, tender ratification) and **ADR-006** (per-workflow
  ownership/admin model) — both accepted 2026-07-23/24, resolving the two open questions the
  2026-07-22 reconciliation explicitly left for a human: `tender` is now the platform's 8th
  module (optional category, `modules.category` column itself not yet built — tracked as #165),
  and the per-workflow ownership model is permanent, accepted policy.
- **ADR-007** (RLS for `entity_types`/`workflows`/`workflow_states`/`workflow_transitions`) —
  accepted; implementation in PR #181 (open, not yet merged — CI green, awaiting a fresh review
  since the one approval it got was auto-dismissed by a post-approval merge + 1-line fixture fix).
- **Nit-bug batches** — PR #186 (#182–185, from reviews of PRs #175/#177/#179/#180) and PR #188
  (#187, #171, #150, #148, #110) bundled and shipped, matching this repo's established pattern of
  batching small independent fixes into one PR. #171 turned out non-trivial: deleting helpdesk's
  vestigial `001_seed.sql` required also templating `002_workflow.sql`'s workflow name via
  `{WORKFLOW_NAME}` (matching #170's convention) so the install-rename fast path kept working,
  which cascaded into fixing a test that hardcoded the literal `"ticket_workflow"` string. Both
  PRs open, CI green, awaiting review.
- **Full docs audit** — read and cross-checked every file in `docs/` (excluding `decisions/` and
  `specs/`) against actual current repo state via 4 parallel review passes. Acted on this session:
  deleted `analysis-2026-05-22.md` and `first-loop-task.md` (fully superseded, confirmed via
  `gh issue view` that every carry-over issue they discuss is closed); tightened
  `phase-timeline.md` (kept the still-true velocity baseline and operating model, cut the
  now-wrong dated projections, restored the Phase 1 carry-over decision table into this doc
  rather than losing it); reconciled this doc (`roadmap-tracker.md`) against the backlog above;
  consolidated all 4 `docs/reviews/*` files into
  [`docs/reviews/pending-review-findings.md`](../reviews/pending-review-findings.md) — only
  still-open findings kept, deduplicated across sources, each noting whether it already has a
  tracked issue (most of the CTO/consulting-review security findings do; most of the
  ux-adoption-review's product findings never got filed at all, which the audit flags as the
  likely reason they saw zero progress since 2026-06-23). **Not acted on this session** (see
  "Next"): `architecture-brief.md`'s phantom `@platform/search` package and never-built
  `inventory` module (omits `tender`); `local-setup.md` missing OpenBao/MinIO entirely (added to
  `docker-compose.yml` after the doc was last touched) and a duplicate, more-stale root
  `SETUP.md`.
- **Assignment clarity:** #161/#162/#163/#165 confirmed informally assigned to Tushar Sharma;
  #143/#125 confirmed informally assigned to Bikash Barnwal (via chat, not GitHub's `assignees`
  field, which this repo has never used). Local-only `open-issues-tracker.md` created (gitignored
  by request) to track this without committing individual names into shared docs.
- **#117** (week-log/roadmap-tracker never updated for #93–#100) — investigated and closed.
  `gh pr view 115` showed `closingIssuesReferences: []`: PR #115's title named all five issues
  but its body never used `Closes #N` syntax, so only #93/#94/#98 auto-closed; #99 and #100
  had sat open for over a month despite the code being genuinely shipped (verified directly —
  `addState`/`updateState`/`deleteState`/`deleteTransition` in `workflow-canvas.tsx`, the
  `PUT /workflows/:id/canvas` endpoint and its `canvas.test.ts`/`canvas.isolation.test.ts`
  coverage). Closed both with an explanatory comment citing the code and this log. This entry
  (above, retitled) and the `roadmap-tracker.md` 2D row now cite all five issue numbers
  explicitly, satisfying #117's literal acceptance criteria — #117 itself closed as a result.

### Phase snapshot

| Track                                                    | Status                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Pre-Phase 3 hardening                                    | Only **#125** (notify→Novu) still fully open. #136/ADR-007 in review (PR #181). |
| Nit-bug batches (#182–185, #187/#171/#150/#148/#110)     | Both PRs (#186, #188) open, CI green, awaiting review                           |
| Unclassified work (child tickets/tender/ownership model) | Resolved — ADR-005 and ADR-006 both accepted 2026-07-23/24                      |
| Phase 3                                                  | Not started, needs human planning sign-off per `CLAUDE.md`                      |

### Next

- Merge #181, #186, #188 (all CI green, awaiting review)
- #143 and #125 — assigned to Bikash Barnwal, not this session's queue
- #161/#162/#163/#165 — assigned to Tushar Sharma, not this session's queue
- Finish the docs audit follow-through: `architecture-brief.md` module-map fix (drop
  `@platform/search`/`inventory`, add `tender`), `local-setup.md` OpenBao/MinIO gap + `SETUP.md`
  duplication
- #165 — implement ADR-005's `modules.category` column + auto-provisioning (Tushar)

### Open questions

- None blocking — both prior open questions (tender scope, ownership-model ADR) resolved this
  session via ADR-005/ADR-006.

---

## 2026-07-23 — Tail of prior hardening sprint: #141, #168, #128, ADR-005 accepted

**Session type:** Backlog (pre-existing work, reconciled into this log after the fact — see
`open-issues-tracker.md`'s note on informal `@username` assignments for why this wasn't logged
in real time)

### Completed

- **#141** (`pnpm lint` repo-wide no-op) — closed via PR #166.
- **#168** (shadow-workflow entity-type-ownership escalation, found during ADR-006 review) —
  closed via PR #172: `UNIQUE(tenant_id, entity_type_id)` migration on `workflows`, atomic
  `onConflictDoNothing()` handling, admin/agent-only role restriction on workflow creation.
- **#128** (OpenBao + MinIO commented out of `docker-compose.yml`) — closed via PR #173.
- **ADR-005** (core vs. optional module classification, tender ratification) — accepted.

### Next

- See 2026-07-24 entry above — this tail fed directly into that session's larger closeout.

---

## 2026-07-24 — ADR-007 accepted and implemented: RLS for workflow config tables (#136)

**Session type:** Feature (ADR-driven hardening)
**Branch:** `feat/PLAT-136-rls-workflow-config-tables`

### Completed this session

- Drafted, adversarially reviewed (three rounds), and got human sign-off on ADR-007, then
  implemented it: migration 0037 adds RLS to `entity_types`/`workflows` (nullable-tenant,
  `entity_fields`-shape) and `workflow_states`/`workflow_transitions` (new `tenant_id NOT NULL`
  column, backfilled, `entity_instances`-shape) — closing the last four tables in the platform
  without a database-level tenant isolation backstop.
- Updated every module's seed SQL (9 files) to supply `tenant_id` for the newly-`NOT NULL`
  columns — without this, every module install would have started failing the moment the
  migration shipped.
- Found and fixed an unrelated pre-existing bug while writing the regression test for
  `tenant-purge.ts`: `admin_audit_log`'s CHECK constraint never allowed the
  `purge.completed`/`purge.failed` actions the purge worker writes, so every real tenant purge
  has been silently failing that audit-trail write in production (migration 0038).
- A second adversarial review (code-level, post-implementation) caught that the `NOT
VALID`/`VALIDATE CONSTRAINT` low-lock migration technique doesn't work in this repo — the
  drizzle-orm postgres-js migrator batches every pending migration into one transaction, so the
  `ADD COLUMN` lock is already held for the whole batch regardless. Simplified both migrations
  back to a direct `SET NOT NULL`. Also added explicit `tenant_id` filters (defense-in-depth,
  alongside RLS) to several `workflow-crud.ts`/`engine.ts`/`canvas.ts`/`tenant-purge.ts` query
  sites that had relied on RLS alone.
- `/security-review` run: no high-confidence findings.
- `docs/decisions/ADR-007-rls-workflow-config-tables.md` still asserts the disproven low-lock
  claim in its Implementation specification — needs a human correction (agents don't edit
  accepted ADRs).

### Verification

- `pnpm typecheck` / `pnpm lint`: PASS (41/41 packages)
- `pnpm test`: PASS (473 tests, up from 472 pre-existing — new symmetric write-block test)
- `pnpm test:isolation`: PASS (170 tests, up from 169) — new `apps/worker/tests/isolation/`
  capability added (didn't exist before this session)

### Next

- #125, #128, #129 remain open in the pre-Phase-3 hardening backlog (unrelated to this session)
- Human correction needed on ADR-007's Implementation specification (low-lock claim)
- Production row counts for `workflow_states`/`workflow_transitions` still unconfirmed before
  this migration runs against a real environment (ADR-007 Open Question OQ-1)

---

## 2026-07-22 — Doc reconciliation: PRs #144/#151/#152/#155 surfaced, #127 closed out

**Session type:** Docs (comprehensive project review)
**Branch:** `docs/PLAT-127-tracker-reconciliation`

### Completed this session

- Pulled 23 new commits on `main` (up to PR #155) and ran a full review: vision-alignment
  check against `architecture-brief.md`/ADRs, a security/architecture pass on the new surface,
  and a local health check (typecheck/lint/test).
- Found `CLAUDE.md`, `roadmap-tracker.md`, and `week-log.md` had not been updated for PR #144
  (2026-07-16: child tickets, a new `modules/tender` vertical, access requests, security
  hardening) or PRs #151/#152/#155 (2026-07-21: tenant-org-id mapping, request-access UI,
  per-workflow ownership model + closing #127). This work was authored outside the
  `openwind-loop` process — no plan-lock, no PROGRESS.md entries for the feature work itself
  (only a later security-audit pass on top of it got logged) — which is why these three files
  went silent on it.
- Verified directly in code (not just the PR title) that **#127 is genuinely closed**:
  `setEntityState`/`bulkSetState` (`packages/entity-engine/src/engine.ts`) now both insert a
  `workflow_events` row and a `workflow.transitioned` outbox event when the state changes.
  Marked closed in `CLAUDE.md`.
- Security/architecture review of the new surface (access-request/grant/revoke flow,
  child-ticket routes, tenant-org-id mapping, `modules/tender`) found no IDOR or escalation
  path: RLS + explicit tenant filters present, 404-not-403 followed, org-id mapping fails
  closed, the new `read_only` ACL only widens read paths, and `modules/tender` genuinely
  respects the zero-TypeScript rule.
- New finding, not yet filed: `setEntityState`/`bulkSetState` don't validate the target state
  against `workflow_states` (unlike `updateEntity`) — noted in `CLAUDE.md` and the tracker, not
  fixed this session.
- Flagged two decisions for human/ADR sign-off rather than deciding them in the docs: (1) is
  `tender` a sanctioned 8th module, and (2) an ADR for the new per-workflow ownership/admin
  authorization model introduced by PR #155.
- Re-confirmed **#141** (`pnpm lint` no-op) is still live: `turbo run lint` only executes
  `build` tasks; zero packages have a real `lint` script.
- Re-checked **#149**: its title claims "9 pre-existing failures," but the issue body lists 4
  and `view-configs.test.ts` itself has exactly 4 `it()` blocks — the count looks stale/wrong;
  flagged, not corrected in the issue itself this session.
- Added the new shipped-but-unclassified work as its own section in `roadmap-tracker.md`
  (cross-referencing the specs behind it) rather than slotting it into an existing phase.

### Phase snapshot

| Track                                                         | Status                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Pre-Phase 3 hardening                                         | #121, #122, #126, #127, #120, #123, #124 closed. #125, #128, #129 open.       |
| Unclassified (child tickets/tender/access-requests/ownership) | Shipped on `main`; pending ADR + phase classification — human decision needed |
| Phase 3                                                       | Not started                                                                   |

### Next

- Human decision: tender module scope (ADR or explicit rejection) + ADR for the per-workflow
  ownership/access-grant authorization model
- File + fix: `setEntityState`/`bulkSetState` missing state-value validation
- Reconcile `#149`'s stated failure count against its own body/the test file
- Remaining open hardening items: #125, #128, #129, #136, #141, #143
- Small open housekeeping: #148 (corepack integrity hash), #150 (`PROGRESS.md`
  gitignore-claim contradiction), #116/#117 (export-pattern ADR + week-log backfill)

### Open questions

- Should `tender` be folded into the standard module list (`architecture-brief.md`'s 8-module
  map currently lists _inventory_, not _tender_), or treated as one-off/reconsidered? Owner
  decision required — not made in this session.

---

## 2026-07-21 — PR #155 merged; #127 closed + IDOR gaps + per-workflow ownership

**Session type:** PR review + doc cleanup
**PRs merged this session:** #151, #152, #153, #154, #155

### Completed this session

- PR #151 (`fix(auth,api): map Zitadel org ids to tenants; accept read_only ACL level`) — reviewed
  and approved (@TusharSharma991). Org→tenant UUID lookup production fix, `zitadel_org_id` column,
  `read_only` ACL level treated as sufficient for entity reads.
- PR #152 (`feat(admin-ui,portal): request-access UI on record detail`) — CHANGES_REQUESTED
  (IMP-1: portal noAccess check fired on any 404, not just the record fetch); fix validated and
  approved.
- PRs #153, #154 — merged (confirmed by user; no review sessions this session).
- PR #155 (`feat(workflow-engine,api,admin-ui): per-workflow ownership/admin model + #127/IDOR fixes`)
  — thorough review posted as CHANGES_REQUESTED with 2 blockers:
  - BLOCKER-1: four IDOR-fix routes used `hasEntityReadAccess` instead of `hasEntityAccess`,
    locking workflow admins out of record events/relations/transitions.
  - BLOCKER-2: migration `0033_workflow_created_by` out of order in `_journal.json` (appended
    after already-applied 0034); renumbered to 0035.
    Fix commit `0793254` addressed both blockers + tightened `grant-access.ts` test (G-3). Approved
    and merged to main (2026-07-21T15:01Z).

### Hardening checklist delta

| Issue                                                     | Status     | PR   |
| --------------------------------------------------------- | ---------- | ---- |
| #127 `setEntityState`/`bulkSetState` unguarded            | ✅ Closed  | #155 |
| IDOR on list-events/relations/transitions/workflow-events | ✅ Fixed   | #155 |
| Per-workflow `created_by`/`assigned_to` ownership model   | ✅ Shipped | #155 |

### Phase snapshot

| Track                 | Status                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| Pre-Phase 3 hardening | #121, #122, #126, #120, #123, #124, #127 closed. #125, #128, #129, #141 open. |

### Next

- #125 — wire Novu delivery worker (notify action is a stub)
- #128 — uncomment OpenBao + MinIO in `docker-compose.yml`
- #129 — worker HTTP readiness probe
- #141 — `pnpm lint` no-op fix (real lint scripts per package)
- #136 — RLS policies for `entity_types`/`workflows`/`workflow_states`/`workflow_transitions`
- PR #155 G-1/G-2 follow-up: dead `createdBy` forwarding in `handle-workflow-error.ts`; `list-slugs.ts` disclosure acknowledgement

---

## 2026-07-24 — workflow builder UX pass + template visibility governance + Docs guardrail stage

**Session type:** UI/UX polish + one new feature (not on the tracked #120–#129 backlog)
**Branch:** `workflow`

### Completed this session

- **Cascading rename restored, with a real fix over the earlier version**: renaming a Step's
  internal name in the workflow builder cascades into `workflow_transitions.fromState`/`toState`,
  `workflows.initialState`, **and now `entity_instances.currentState`** — the earlier version of
  this feature missed the last one, which would have silently stranded in-flight tickets on a
  stale state name. New engine-level test coverage added (`workflow-crud.test.ts` — did not exist
  before).
- **Workflow builder terminology**: Steps/Actions/Details to Collect plain-language pass applied
  to `apps/admin-ui/src/pages/workflows/index.tsx` (the workflow list) — the detail page had
  already been rewritten in an earlier session; the list page was missed and still said "state
  machine definitions."
- **Fixed a real naming bug**: `sales-pipeline`/`nsi-amendment`/`tender`/`helpdesk` seed SQL
  hardcoded `workflows.name` to a raw snake_case slug (used as an internal lookup key across
  seed statements), so the UI displayed e.g. `sales_pipeline_workflow` verbatim instead of a
  human-readable name. Fixed by switching to the existing `{WORKFLOW_NAME}` substitution token
  and re-keying internal lookups on `entity_type_id` instead of `name`.
- **Fixed app-wide validation error messages**: `@hono/zod-validator`'s default (no-hook)
  behavior returns the raw `ZodError` object as `body.error`; the frontend's
  `new Error(body.error)` stringified that to the literal text `"[object Object]"` for every
  validation failure across the entire app, not just one route. Added
  `apps/api/src/lib/validator.ts`, a typed wrapper that formats a readable message + fields
  array, rewired across all 58 route files' imports.
- **Removed Email/URL from the Detail Type dropdown** — neither was ever a real backend field
  type (`packages/entity-engine/src/field-types.ts`), so selecting either always failed
  validation silently.
- **UI polish pass** across `/records`, `/records/:type/records` (kanban board), the record
  detail page, `/modules`, `/workflows`, and `/settings`: fixed washed-out grey card
  surfaces (a page-background-vs-card-background contrast bug — introduced a `--bg-card` /
  `--bg-secondary` layering convention used consistently going forward), added consistent card
  shadows, fixed-height kanban columns with internal scroll, fixed-height record cards with
  buttons pinned to the bottom, added search to `/records`, redesigned the `/workflows` list
  (stats overview strip, active/inactive grouping, per-workflow entity icons, larger rows).
- **New feature — template visibility governance** (not part of the tracked backlog, direct
  ask): `modules.is_visible` (migration `0039_module_visibility.sql`), a global platform-wide
  toggle. `GET /modules` (Templates page) is always filtered to visible-only for every role,
  including admin — `GET /modules?includeHidden=true` (admin-only, used by the new Settings
  page management card) sees hidden ones too, so admin can re-enable them. 7 new route tests.
  This platform has no separate `superadmin` tier — `admin` is the top role — the feature was
  built once for `superadmin` and corrected to `admin` mid-session.
- **Guardrail tooling**: added a **Docs** stage to the Plan → Code → Review → Docs → Ship
  pipeline. New `write-docs-marker.sh` hook (`--touched` or `--skip "<reason>"`), wired into
  `commit-gate.sh` (blocks `git commit` without a docs marker matching the current diff, same
  binding pattern as the existing review marker), `ship-cleanup.sh` (one-shot cleanup),
  `.claude/README.md`, `agent-behaviour.md`, `definition-of-done.md`, and `CLAUDE.md` updated
  to document it. This week-log entry + the Docs stage addition are themselves the marker's
  first real use.

### Phase snapshot

No change to Phase 3 hardening backlog status this session — this was direct UI/UX work +
one ad-hoc feature request, not #120–#129 progress. #127 is still the next hardening item.

### Next

- Pick up #127 (`setEntityState`/`bulkSetState` unguarded state side-doors) — still next in
  the hardening queue, untouched this session.
- The workflow ID-based-linking spec (`docs/specs/workflow-id-based-linking.md`) remains
  drafted but not implemented — paused earlier this session in favor of the smaller
  cascading-rename fix; revisit if step-deletion/reordering becomes a near-term priority.

---

## 2026-07-10 — close out #120 in docs (PR #139 merged 2026-07-09)

**Session type:** Docs (following code merge)
**Branch:** `docs/PLAT-120-checklist-update`

### Completed this session

- PR #139 (`workflow.transitioned` outbox double-trigger + depth-reset fix, #120 — the
  `entity.assigned` outbox event itself was introduced earlier by PR #138/#126; #139 only
  added depth-carrying to that existing payload) confirmed merged to `main`
  (2026-07-09T11:09:01Z), including the full PR review-fix round (positive-allowlist outbox
  routing, dead-letter `system.error` rows, depth-leak fix in condition evaluation, vitest
  alias, test cleanup fixes) and issue #143 (Phase 3A outbox/connector tracking issue, filed
  during the #139 review — not a PR, still open).
- PR #142 (docs reconciliation for #126) confirmed merged — approved by @PrabhuVijit with
  two non-blocking suggestions (expected week-log drift; a note to flag #120/#127 ordering
  in the next reconciliation, addressed below).
- `CLAUDE.md`: marked #120 done in the hardening checklist; added a note that #120 (PR #139)
  merged ahead of #127, out of the queue's originally stated priority order (#127 was still
  next based on the 2026-06-29 consulting review, but #126 and #120 were in the same review
  session and merged the same day (2026-07-09), so #120 landed before #127 was picked up)
  — #127 remains the next item to pick up.
- `docs/reviews/2026-06-29-consulting-review.md`: struck #120 from the "Close remaining
  hardening items" action-list line, renumbered the remaining items.

### Phase snapshot

| Track                 | Status                                                                |
| --------------------- | --------------------------------------------------------------------- |
| Pre-Phase 3 hardening | #121, #122, #126, #120 closed. #127 next. #123–#125, #128, #129 open. |

### Next

- #127 — guard `setEntityState`/`bulkSetState` (audit/compliance side-door)
- Remaining hardening items #123, #124, #125, #128, #129
- #136 — RLS policies for `entity_types`/`workflows`/`workflow_states`/`workflow_transitions`
- #141 — `pnpm lint` no-op needs its own session
- #143 — Phase 3A connector design must account for the outbox/workflow_events gap

---

## 2026-07-09 — #126 merged; doc reconciliation

**Session type:** Docs (following code merge)
**Branch:** `docs/PLAT-126-checklist-update`

### Completed this session

- PR #138 (`entity.created`/`entity.assigned` outbox triggers, #126) merged to `main`,
  including the full PR review-fix round (redaction fail-open fix, seed-validation
  discriminated union, drift-detection test, bulk-path isolation tests).
- Resolved `PROGRESS.md` merge conflicts on both `fix/PLAT-126-entity-created-triggers`
  (against `main`) and `fix/PLAT-120-automation-depth-recursion` (against `main` post-#138)
  — conflicts were from concurrent log entries, not competing code changes.
- Found PR #139 (#120) was still based on the now-merged `fix/PLAT-126-entity-created-triggers`
  branch instead of `main` (a stacked-PR setup from before #138 merged), which silently
  prevented CI from triggering (`ci.yml`'s `pull_request` trigger only matches
  `branches: [main, develop]`). Retargeted to `main` and cycled the PR closed/reopened to
  force a `synchronize` CI run (changing the base fires `edited`, which isn't a default
  trigger type).
- `CLAUDE.md`: marked #126 done in the hardening checklist.
- `roadmap-tracker.md`: cleared the stale 2B gap note about `entity.created` never firing;
  updated "Last updated" line.
- `docs/reviews/2026-06-29-consulting-review.md`: added ✅ RESOLVED notes for #126 (Blocker 3,
  the reality-check table row, and the prioritized action list), matching the #121/#122
  pattern from the prior session.

### Phase snapshot

| Track                 | Status                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Pre-Phase 3 hardening | #121, #122, #126 closed. #120 (PR #139) open, CI running. #127, #123–#125, #128, #129 open. |

### Next

- Watch PR #139 (#120) CI to green, then merge
- #127 — guard `setEntityState`/`bulkSetState` (audit/compliance side-door)
- Remaining hardening items #123, #124, #125, #128, #129
- #136 — RLS policies for `entity_types`/`workflows`/`workflow_states`/`workflow_transitions`
- #141 — `pnpm lint` no-op needs its own session

---

## 2026-07-08 — Consulting-review followup: doc reconciliation

**Session type:** Documentation
**Branch:** `docs/consulting-review-followup-121-122`

### Completed this session

- Updated `docs/reviews/2026-06-29-consulting-review.md` with ✅ RESOLVED notes for #121/#122
  (closed via PR #135) and the three quick-win doc fixes below
- `roadmap-tracker.md`: Phase 2 gate wording changed from "Pilot customer onboarding" to
  "Pre-Phase 3 hardening items #120–#129 all closed"
- `platform-vision.md`: added a numbering-note callout above the Phase 0–6 roadmap diagram —
  investigation found the "Phase 2 ▶ NEXT" the review flagged as contradicting CLAUDE.md
  wasn't stale data, it's a different numbering scheme (this doc's Phase 0–6 long-term
  roadmap vs. CLAUDE.md's Phase 1/2/3 execution tracking) that was undocumented and
  confusing; added the mapping instead of changing the (accurate) diagram status
- `CLAUDE.md`: added ADR-004 (config-first module design) to the reference docs list,
  surfaced second (after `architecture-brief.md`) per the review's §8 observation;
  description softened to "most directly relevant to module authoring decisions"

### Phase snapshot

| Track            | Status                                                      |
| ---------------- | ----------------------------------------------------------- |
| Hardening sprint | 🟡 2/10 — #121, #122 closed (PR #135); #120, #123–#129 open |
| Phase 3          | 🔴 Not started (blocked by hardening)                       |

### Next

#126 (`entity.created`/`entity.assigned` triggers), then #127 (guard `setEntityState`/
`bulkSetState`) — both core-function/compliance gaps per the consulting review's immediate
priority list.

---

## 2026-07-07 — Hardening #121 / #122: RLS role enforcement (PR #135)

**Session type:** Feature / security fix
**Branch:** `fix/PLAT-121-rls-role` → PR #135 (merged)

### Completed this session

- `withTenantContext` / `executeRawInTenantContext` now issue `SET LOCAL ROLE app_user`
  before setting the tenant GUC, closing #121
- Migration `0022_app_user_rls_grants.sql` grants `app_user` the write privileges needed to
  keep existing routes working under the new role (later tightened to column-scoped grants
  on `tenants` per PR review)
- Un-skipped the three cross-tenant RLS isolation tests, closing #122; one had no real
  assertion at all and needed a genuine fixture (a vacuous-test bug caught in code review)
- Filed #136 to track a separately-scoped gap found during review: `entity_types`/
  `workflows`/`workflow_states`/`workflow_transitions` have no RLS policy at all

### Phase snapshot

| Track            | Status                                |
| ---------------- | ------------------------------------- |
| Hardening sprint | 🟡 2/10 — #121, #122 closed           |
| Phase 3          | 🔴 Not started (blocked by hardening) |

### Next

#126, then #127.

---

## 2026-06-24 — Post-review followup (PR #130)

**Session type:** Documentation / tracking
**Branch:** `docs/post-review-followup` → PR #130

### Completed this session

- Created GH issues #120–#129 for all 10 pre-Phase 3 hardening items (labelled `phase:2`)
- Backfilled issue links into CLAUDE.md hardening checklist
- Written PROGRESS.md with priority-ordered hardening sprint and session handoff
- Fixed VISION.md wording, platform-vision.md P1 chart style (S2 from review)
- Addressed PR #130 review: CLAUDE.md gate changed from "pilot" to "3A start"; checklist reordered by dependency; roadmap-tracker now lists both label queries; agent-behaviour.md PROGRESS.md template updated; PROGRESS.md cleaned up

### Phase snapshot

| Track            | Status                                |
| ---------------- | ------------------------------------- |
| Hardening sprint | 🔴 0/10 — issues open, not started    |
| Phase 3          | 🔴 Not started (blocked by hardening) |

### Next

Start hardening sprint at #121 (RLS role fix).

---

## 2026-06-23 — External review; doc reconciliation

**Session type:** Documentation / planning
**Branch:** `main`, clean

### Completed this session

- Received three-lens external review (CTO architecture + risk, Product capability, UX adoption) dated 2026-06-23.
- Reconciled CLAUDE.md, VISION.md, db-conventions.md with code reality (Phase 2 was 100% complete but docs still showed 0%/95%).
- Identified pre-Phase 3 hardening items (10 issues, no code changed yet — see CLAUDE.md Current Focus).

### Key findings (external review)

- **Engineering health: 6.5/10.** Well-architected core; dragged down by untested RLS guarantee, unbounded automation recursion, and dev-grade ops.
- **Product capability: ~80% of platform engine built.** Gaps: notification delivery is a stub, `entity.created`/`entity.assigned` triggers never fire, `setEntityState` is an unguarded side-door, 6 of 7 module seeds have no automations.
- **UX adoption: 7/10.** Strong admin experience; portal field inputs for `file`/`user_ref`/`entity_ref`/`formula`/`lookup` fall back to plain text inputs. No a11y floor on modals, no i18n, no demo seed data.
- **Docs were stale:** CLAUDE.md showed 2B as "0% done", VISION.md showed 2A as "95%". Both corrected.
- **Dangerous doc:** `db-conventions.md` said "no query needs WHERE tenant_id" — corrected to require both explicit filters AND RLS.

### Phase snapshot

| Track   | Status           |
| ------- | ---------------- |
| Phase 2 | ✅ 100% complete |
| Phase 3 | 🔴 Not started   |

### Next

- Human planning sign-off required before Phase 3 (3A) starts.
- Pre-Phase 3 hardening sprint recommended (10 items in CLAUDE.md) before pilot goes live.

---

## 2026-06-18 — Track 2D export API + workflow canvas — PR #115 merged (issues #93, #94, #98, #99, #100)

**Session type:** Feature implementation + review cycle (4 rounds)
**Branch:** `feat/93-98-export-api-workflow-canvas` → PR #115 merged

Covers all 5 issues from this track: #93 (export API), #94 (export UI), #98 (workflow
canvas), #99 (canvas edit ops — add/rename/delete state, delete transition), #100 (atomic
canvas save endpoint + dirty-state/`beforeunload` guard). PR #115's title named all five but
its body never used `Closes #N` syntax, so GitHub only auto-closed #93/#94/#98 — #99/#100
sat open until caught and closed on 2026-07-24 (see that entry below) despite the code
having shipped here.

### Completed this session

**Export API (async BullMQ path)**

- `GET /entity-types/:id/export` — sync path (≤5k rows) returns binary; async path (>5k) enqueues BullMQ job, returns `{ jobId }` with 202
- `GET /exports/:jobId/download` — polls job state; `requireRole("agent", "admin")`; null-guard on `returnvalue` returns `EXPORT_EXPIRED` after TTL; all responses wrapped in `{ data: T }` envelope; cross-tenant and PII gate enforcement (404 not 403)
- `apps/worker` export processor: `renderExportPdf` kept local to `apps/api` and `apps/worker` (dependency boundary: `entity-engine → db only`); pdfkit removed from entity-engine
- `useExport` hook extracted to `apps/admin-ui/src/lib/use-export.ts` and `apps/portal/src/lib/use-export.ts`; 13-test suite covering full polling state machine

**Workflow canvas**

- `PUT /workflows/:id/canvas` — upsert states + transitions in a single transaction; initial-state deletion guard (422); cross-tenant 404
- `WorkflowCanvas` React component: module-level `_newCounter` moved into `useRef` to fix React 18 StrictMode double-invoke; `isAdmin` wired from real Zitadel JWT roles; `beforeunload` guard when canvas is dirty

**Tests added**

- `canvas.test.ts`: 14 unit tests (create/update/delete states+transitions, initial-state guard, cross-tenant 404, role rejection)
- `canvas.isolation.test.ts`: 5 isolation tests incl. cross-tenant 404, initial-state guard, non-admin 403
- `export.isolation.test.ts`: 6 tests — 3 DB-level RLS + 3 HTTP download access-control (cross-tenant, PII gate, allowed case)
- `download.test.ts`: 10 unit tests incl. EXPORT_EXPIRED null-returnvalue case
- `use-export.test.ts`: 13 hook state machine tests (added `@testing-library/react` + jsdom to admin-ui)

### Key decisions / gotchas

- `c.json()` cannot return inside `withTenantContext` callback — threw sentinel error with `.code` and caught it outside
- BullMQ `removeOnComplete: { age: 3600 }` — `job.returnvalue` is `null` after TTL; must null-guard before reading `downloadUrl`
- commitlint: subjects must be entirely lowercase — no camelCase, PascalCase, or acronyms
- Lockfile must be committed after any `package.json` change; CI uses `--frozen-lockfile`

### Phase snapshot

| Track                          | Status                   |
| ------------------------------ | ------------------------ |
| Track 2D — no-code + reporting | ✅ Done — PR #115 merged |
| Phase 2                        | ✅ **100% complete**     |

### Next

- Phase 2 is complete. Phase 3 planning required before starting 3A–3D.
- Carry-over ADR for export async design (#116) and week-log update (#117) remain open per reviewer notes.

---

## 2026-06-16 — Track 2D Phase 2 — admin-ui automation builder, saved views, export, workflow editor (issue #15, PR #107)

**Session type:** Feature implementation
**Branch:** `feat/15-track-2d-phase2-admin-ui` → PR #107 open for review

### Completed this session

**Track 2D Phase 2 admin-ui (T10–T21 of 24)**

- **T10** — automation rules list page with enable/disable toggle, delete, link to wizard
- **T11** — `step-trigger.tsx`: trigger type picker + dynamic config (workflow/state selects, entity type/field selects)
- **T12** — `step-conditions.tsx`: recursive conditions builder (AND/OR groups, field comparisons, add/remove/nest)
- **T13** — `step-actions.tsx`: actions builder supporting `notify`, `set_field`, `transition`, `webhook` action types
- **T14** — `step-save.tsx` + `wizard.tsx`: 4-step wizard shell with progress indicator, edit mode pre-populate, POST/PATCH on save
- **T15** — wired `/automations`, `/automations/new`, `/automations/:id/edit` routes in `App.tsx`; nav entry in `layout.tsx`
- **T16** — workflow detail: `StateEditPopover` — clicking a state circle opens inline edit for label/color/SLA, PATCH on save
- **T17** — workflow detail: dnd-kit drag-to-reorder states with optimistic update + rollback on failure
- **T18** — workflow detail: SVG quadratic bezier arcs for non-adjacent transitions (arc height scales with state gap, arrowhead marker)
- **T19** — admin-ui record list: saved views dropdown, auto-apply default view, save-current-filter modal
- **T20** — admin-ui record list: CSV/xlsx export split-button; EXPORT_TOO_LARGE banner
- **T21** — portal record list: same saved views + export (mirrors admin-ui)

**Key implementation notes:**

- `(value as Type) ?? fallback` ESLint pattern: cast must be `as Type | undefined` when `??` is used, otherwise `no-unnecessary-condition` fires
- dnd-kit `setNodeRef` expects `Element | null`; custom `Map<string, HTMLDivElement>` requires `setNodeRef(el as unknown as HTMLElement)` workaround
- `useLayoutEffect` without deps array for SVG arc measurement — intentional, always re-measure after any layout change
- `jsx-a11y/anchor-has-content` rule is not installed in this project; do not add eslint-disable comments for it

### Still pending (Phase 2 gate not fully met)

- **T5** — saved-views RLS isolation test (`tests/isolation/saved-views.test.ts`) — needs Docker; deferred

### Phase snapshot

| Track                          | Status                                |
| ------------------------------ | ------------------------------------- |
| Track 2D — no-code + reporting | 🔄 Phase 2 admin-ui: 12/13 tasks done |

---

## 2026-06-16 — Track 2D Phase 1 — saved views API + entity export (issue #15)

**Session type:** Feature implementation
**Branch state:** `main`, 1 commit ahead of origin (6d804f0)

### Completed this session

**Track 2D Phase 1 backend (T1–T4, T6–T9 of 24)**

- **T1** — migration 0018: `saved_views` table with dual RLS policy (`tenant_id` + `user_id` GUCs), cascade FK to `entity_types`, analytics comment included
- **T2** — Drizzle schema (`packages/db/src/schema/saved-views.ts`); `withTenantAndUserContext` helper added to `packages/db/src/middleware.ts` — sets both `app.tenant_id` and `app.user_id` in one call
- **T3** — saved-views CRUD: `GET /saved-views?entityTypeId=`, `POST /saved-views` (max-20 limit, userId always from auth), `PATCH /saved-views/:id`, `DELETE /saved-views/:id`; wired into `app.ts`
- **T4** — 11-test unit suite: list, create 201, max-20 → 409, userId injection prevention, isDefault clears prior, update 200/404, delete 204/404 — all passing
- **T6–T8** — `GET /entity-types/:id/export?format=csv|xlsx`; PII/financial field exclusion by role; EXPORT_TOO_LARGE guard at 10k; system cols first; exceljs bold header + auto-width; routed before `/:id` to avoid conflict
- **T9** — 14-test export suite: CSV/xlsx content-types, PII exclusion by role (agent vs pii_export/admin), EXPORT_TOO_LARGE, empty → headers-only, 404 on missing entity type — all passing

**Key implementation notes:**

- `getEntityType` throws `EntityError("ENTITY_TYPE_NOT_FOUND")` rather than returning null — caught and mapped to 404
- xlsx uses `c.newResponse()` not `new Response()` to avoid undici-types portability error
- `requireAuth()` mock in export tests is a pass-through so `makeApp(roles)` controls per-test role

### Still pending (Phase 1 gate not fully met)

- **T5** — saved-views RLS isolation test (`tests/isolation/saved-views.test.ts`) — needs Docker stack running; skipping until integration environment is available

### Phase snapshot

| Track                          | Status                             |
| ------------------------------ | ---------------------------------- |
| Track 2D — no-code + reporting | 🔄 Phase 1 backend: 8/9 tasks done |

---

## 2026-06-16 — Pre-pilot engine fixes (#76–#84); PR #89 merged

**Session type:** Bug fix / pre-pilot hardening
**Branch state:** `main`, clean (PR #89 merged — f51ac01)

### Completed this session

**9 issues closed (#74–#84 scope — #74/#75 were prior, #76–#84 this session)**

- **#76 — ioredis migration**: created `@platform/redis` singleton package (`getRedis`, `closeRedis`); removed `node-redis` from `entity-engine`; schema-cache SCAN cursor fixed to string `"0"`, SET EX uses ioredis positional args, DEL spreads keys
- **#77 — idempotency pre-lock**: moved idempotency read-only SELECT before `FOR UPDATE NOWAIT` in `executeTransition` to short-circuit without acquiring the write lock
- **#78 — bulkCreateEntities O(N) DB calls**: request-scoped `Map` caches `entityType` + `allFields` per `typeId`; schema stays per-item (uses its own Redis cache)
- **#79 — deleteEntity single round-trip**: collapsed SELECT + UPDATE into `UPDATE...RETURNING` with `isNull(deletedAt)` in WHERE
- **#80 — error handler messages**: workflow and entity engine errors return human-readable `message` fields instead of raw codes
- **#81 — ActionConfig discriminated union**: replaced `Record<string,unknown>` config + unsafe casts in executor with a typed discriminated union; all switch arms narrow cleanly
- **#82 — duplicate migration prefixes**: renumbered `0001`/`0002` collisions to sequential `0002`/`0003`/`0004`; Drizzle journal updated
- **#83 — automation-engine notify async**: removed spurious `async` from `executeNotifyAction` (no await); added TODO for re-wire
- **#84 — /health NODE_ENV leak**: removed `env: env.NODE_ENV` from health response body

**PR #89 review fixes (two rounds):**

- Added `server.deps.inline` for `@platform/redis` + `@platform/db` to all three engine vitest configs
- Wired `closeRedis()` into graceful shutdown for `apps/api` (new SIGTERM/SIGINT handler) and `apps/worker`
- Fixed residual `isRedisReady()` call in `invalidateSchemaCache`
- Added 6-test suite for `@platform/redis` (singleton, constructor args, error handler, quit, reset, no-op)
- Fixed `tsconfig.json` to exclude test files from tsc build
- `server.close()` wrapped in `Promise` so in-flight requests drain before `closeRedis()` on SIGTERM

### Phase snapshot

| Track                                | Status                        |
| ------------------------------------ | ----------------------------- |
| Issues #76–#84 (pre-pilot hardening) | ✅ All closed — PR #89 merged |
| 2D (no-code builders + reporting)    | 🔴 Not started — next track   |

---

## 2026-06-10 — Tenant lifecycle (issue #5 items 1+2); PR #86 open

**Session type:** Implementation
**Branch state:** `feat/PLAT-5-tenant-lifecycle`, PR #86 open

### Completed this session

**Issue #5 — Tenant lifecycle, items 1+2 (item 3 outbox retention deferred)**

- **Migration 0013**: `suspended_at` and `deletion_scheduled_at` columns on `tenants`; partial index `tenants_deletion_due_idx` for purge worker
- **`packages/auth` — tenant status cache**: 30 s TTL Map-based cache (`tenant-status-cache.ts`); `invalidateTenantStatusCache` exported; auth middleware enforces 403 (suspended) / 404 (deleted / purged) on every authenticated request
- **`apps/api` — tenant-lifecycle service**: `provisionTenant`, `suspendTenant`, `reactivateTenant`, `scheduleTenantDeletion`; typed `TenantLifecycleError`; cache invalidated on every transition; 30-day BullMQ purge job enqueued by `scheduleTenantDeletion`
- **Admin routes** `/admin/tenants` (POST / GET / PATCH suspend+reactivate / DELETE): all gated by `requireRole("superadmin") + requireIntrospection()`
- **`apps/worker` — tenant-purge BullMQ worker**: concurrency=1; FK-safe deletion order; audit log retained; marks tenant `purged` on completion; idempotent
- **Tests**: 9 unit tests (lifecycle service); auth middleware mock updated for `db`/`tenants` imports; 38/38 typecheck clean; 21/21 auth tests pass

### Phase snapshot

| Track                                 | Status                                |
| ------------------------------------- | ------------------------------------- |
| Issue #2 (SSRF + PII)                 | ✅ Done — PR #85 merged               |
| Issue #5 (tenant lifecycle items 1+2) | 🟡 PR #86 open — awaiting CI + review |

---

## 2026-06-09 — 2A Phase 3 complete (T18–T23); PR #85 updated

**Session type:** Implementation
**Branch state:** `feat/PLAT-12-platform-services-2a`, ahead of `main`, PR #85 open

### Completed this session

**2A Phase 3 — PII-aware audit snapshots + integration / isolation tests**

- **T18 — audit hook in entity engine**: added `audit-hook.ts` with `registerEntityAuditHook` / `fireEntityAuditHook` / `isEntityAuditHookRegistered`. Preserves `packages/entity-engine → packages/db only` dependency rule — hook is a callback registered by `apps/api` at startup, not a direct import.
- Entity engine `createEntity`, `updateEntity`, `deleteEntity` now fire the hook with before/after snapshots and the field sensitivity map.
- `apps/api/src/app.ts` registers `writeAuditEntry` as the hook at module load, inside the same DB transaction.
- **T19 — files RLS isolation test**: 5 assertions — cross-tenant read blocked, own-tenant read allowed, cross-tenant delete returns FILE_NOT_FOUND, cross-tenant `confirmUpload` throws FileError.
- **T20 — audit_log RLS isolation test**: 4 assertions — cross-tenant raw SELECT blocked, `queryAuditLog` API scoped to correct tenant.
- **T21 — view_configs RLS isolation test**: 5 assertions — cross-tenant read + write (INSERT WITH CHECK) blocked.
- **T22 — upload flow integration**: 6 tests — `initiateUpload` → `confirmUpload` → `getDownloadUrl` → quarantine guard → `deleteFile` → size limit guard.
- **T23 — quarantine lifecycle integration**: 6 tests — `pending` download blocked, quarantined blocked, `scan_failed` blocked, clean succeeds, idempotent re-download.
- Fixed wrong function names (`completeUpload` → `confirmUpload(db, redis, tenantId, fileId)`, `downloadFile` → `getDownloadUrl`) in all three test files.
- Fixed `FieldSensitivity` re-export: `workflow-engine/index.ts` now re-exports it from `@platform/entity-engine` so `@platform/audit` can import transitively.
- All 141 unit tests pass. Integration/isolation tests require `docker compose up -d` (expected).

### Phase snapshot

- Phase 1: **100% complete**
- Phase 2 — 2A: **~95%** (pending: CI green on Docker test suite before merge)
- Phase 2 — 2B/2C/2D: 0% (next)

### Next actions

- [ ] CI must pass on full Docker stack before merging PR #85
- [ ] Start 2B: module system + seed SQL for helpdesk, CRM, reimbursements
- [ ] Phase exit decision (2A → 2B) requires human sign-off

---

## 2026-06-09 — 2A Phase 1 + 2 complete; SSRF/PII PR merged

**Session type:** Implementation
**Branch state:** `feat/PLAT-12-platform-services-2a`, ahead of `main`, PR open

### Completed this session

**SSRF + PII hardening (PR #73 — merged)**

- Fixed `opts.all = true` crash in `webhook.ts` `lookupFn` (`ERR_INVALID_IP_ADDRESS` on Docker happy-eyeballs path)
- PR reviewed by abmish, all 6 blockers resolved, CI green, merged to main

**2A Phase 1 — packages**

- `@platform/notifications`: Novu wrapper, user preference CRUD, `sendNotification`, `getUserPreferences`, `updateUserPreferences`
- `@platform/files`: `initiateUpload` (S3 presigned PUT, quota guard, AV scan queue enqueue), `completeUpload`, `downloadFile`, `deleteFile`, `FileError`
- `@platform/audit`: `writeAuditEntry`, `queryAuditLog`, PII redaction via `redactMetadata` + `buildSensitivityMap`
- DB migrations 0007–0009: `files`, `view_configs`, `audit_log` tables (all with RLS, tenant indexes)

**2A Phase 2 — API routes + workers**

- `apps/api`: file initiate/complete/download/delete routes, admin audit log + view-config routes, notification preferences get/patch routes, `/openapi.json` endpoint, shared Redis client
- `apps/worker`: av-scan BullMQ worker (ClamAV INSTREAM TCP, lazy S3, quarantine notification), file-cleanup hourly recurring worker (purges stale pending files, implicit quota via row deletion)
- 34 tests: 12 file API route tests, 3 av-scan tests, 4 file-cleanup tests (all green)

**Test infra fixes**

- vitest 4.x: `S3Client` and `net.Socket` constructor mocks must use `function` keyword (not arrow function)
- BullMQ Worker processor captured at import time; `beforeEach` must NOT clear the reference

### Phase snapshot

- Phase 1: **100% complete**
- Phase 2 — 2A: **~65%** (Phase 3 integration tests T19–T23 remain)
- Phase 2 — 2B/2C/2D: 0% (next)

### Next actions

- [ ] 2A Phase 3 (T19–T23): isolation + integration tests for files, audit, view-configs; full upload flow; quarantine flow
- [ ] Start 2B: module system + seed SQL for helpdesk, CRM, reimbursements
- [ ] T18 (PII-aware snapshots): wire `buildSensitivityMap` + `redactMetadata` into entity engine hooks

---

## 2026-05-22 — Phase 1 complete, Phase 2 triage

**Session type:** Analysis + cleanup
**Branch state:** `main`, clean

### Completed this session

- Deleted stale local branch `feat/PLAT-007-infrastructure-tenancy-secrets`
- Removed `contributor` remote tracking ref
- Created `docs/sup-docs/` tracking suite

### Phase snapshot

- Phase 1: **100% complete** (all 5 tracks + security hardening closed)
- Phase 2: **0% started** — 4 tracks open, 7 carry-over issues to triage
- Phase 3: **0% started**

### Open Phase 2 blockers to triage

- #3 Workflow reliability gaps (PrabhuVijit — assigned, no PR yet)
- #5 Tenant lifecycle / audit log / outbox retention (abmish — architecture decision pending)
- #2 Data isolation & PII leakage (unassigned)
- #4 Schema cache & Redis efficiency (unassigned)
- #62 Workflow version GC + stuck instances (unassigned)
- #64 Transition rollback / undo policy (unassigned)
- #65 Parallel approval edge cases (unassigned)

### Carry-over triage completed (same session)

- ✅ Closed #3 (tracker — all sub-items resolved)
- ✅ Closed #64 (transition rollback → irreversible by design, ADR-002 WE-02 resolved)
- 🔴 #2 flagged PILOT BLOCKER — SSRF + PII, must land before any customer data
- 🟡 #5 folded into 2A — items 1+2 are 2A work; item 3 deferred to load testing
- 🟡 #4 deferred to pre-GA / load testing
- 🟡 #62 deferred to before 2D (workflow editor)
- 🟡 #65 re-labelled phase:3 — parallel approval off-limits for pilot

### Next actions

- [ ] Start 2A — platform services (Novu, files, audit log, view_configs)
- [ ] #2 (SSRF + PII) must be assigned and worked in parallel with 2A
- [ ] #5 items 1+2 land as part of 2A

---

## 2026-05-20 to 2026-05-21 — Security hardening sprint

**Tracks:** 1-SEC
**PRs merged:** #66 (api keys, ReDoS, cross-tenant user_ref, OpenBao), hotfixes #67, #68, #69
**Issues closed:** #1, #8, #22, #67, #68, #69 → Phase 1 security complete

---

## 2026-05-19 to 2026-05-20 — Automation engine + reliability fixes

**Tracks:** 1E complete, reliability issues 3.1–3.5
**PRs merged:** #49 (automation engine), #58 (SLA timer + TRANSITION_LOCKED)
**Issues closed:** #11 (1E), #59, #60, #61, #63

---

## 2026-05-18 to 2026-05-19 — Workflow engine + entity engine

**Tracks:** 1C complete, 1D complete
**PRs merged:** #33 (entity engine), #40, #41 (workflow engine)
**Issues closed:** #9 (1C), #10 (1D), #24–#39

---

## 2026-05-14 to 2026-05-18 — Infrastructure + auth

**Tracks:** 1A complete, 1B complete
**PRs merged:** #20, #21 (infra/tenancy), #23 (auth)
**Issues closed:** #7 (1A)

---

## 2026-05-13 to 2026-05-14 — Project kickoff

**Scope:** Repo scaffold, architecture docs, ADRs, issue backlog created (issues #1–#19)
**Deliverables:** CLAUDE.md, architecture-brief.md, ADR-001 through ADR-004, roadmap.md, all GH milestones
