# Week-over-Week Progress Log

**Format:** One entry per session or per milestone close. Newest at top.
**Purpose:** Running velocity record for an AI-first dev team. Update this at the start/end of each work session.

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
  ask): `modules.is_visible` (migration `0040_module_visibility.sql`), a global platform-wide
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

## 2026-06-18 — Track 2D export API + workflow canvas — PR #115 merged (issue #93, #98)

**Session type:** Feature implementation + review cycle (4 rounds)
**Branch:** `feat/93-98-export-api-workflow-canvas` → PR #115 merged

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
