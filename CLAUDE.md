# CLAUDE.md — Platform Engineering Context

Loaded automatically at the start of every session.
Detailed rules live in `.claude/rules/` and auto-load — see the index below.

---

## What we are building

A modular, workflow-native business platform. Every module (CRM, helpdesk, HRMS,
reimbursements, etc.) is a configuration of three shared engines: Entity Engine,
Workflow Engine, Automation Engine. Modules are seed SQL + one-line stub index files —
no domain logic TypeScript in `modules/`.

Reference docs (read before starting work in a new area):

- `docs/architecture-brief.md` — full platform architecture
- `docs/decisions/ADR-004-config-first-module-design.md` — config-first module model; the
  ADR most directly relevant to module authoring decisions (zero TypeScript in
  `modules/` — read this before touching anything under `modules/`)
- `docs/decisions/ADR-001-multitenancy.md` — tenancy model and RLS
- `docs/decisions/ADR-002-workflow-engine.md` — state machine design
- `docs/decisions/ADR-003-field-validation.md` — entity validation
- `docs/sup-docs/roadmap-tracker.md` — phase progress and track status
- `docs/sup-docs/week-log.md` — running velocity log (update each session)

---

## Current focus

**Phase:** 3 — Scale & Extensibility (not started — planning required before 3A)
**Phase 2 status:** ✅ Complete as of 2026-06-18 (all 4 tracks + pre-pilot hardening merged)

Phase 3 tracks (all 0% — no active work yet):

| ID    | Track                                               | Notes                                                                                              |
| ----- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 3A    | Integration layer — connector runtime, marketplace  | Next. Requires human planning sign-off. Write `.claude/context/phase-3-primer.md` before starting. |
| 3B    | Plugin system — Module Federation, slot registry    | After 3A                                                                                           |
| 3C    | AI layer — automation gen, workflow suggestion, RAG | After 3B                                                                                           |
| 3D    | Observability + compliance — OTel, Prometheus, GDPR | Parallel with 3A–3C possible                                                                       |
| 3-OPS | Deferred ops/infra concerns                         | See Phase 1 carry-overs in tracker                                                                 |

**Pre-Phase 3 hardening (external review flagged — complete before starting 3A):**

These are not Phase 3 features — they are correctness/safety fixes in existing code.
Work in this order (sequential dependencies at the top). **#126 and #127 jump the original
queue** per the 2026-06-29 consulting review §6 ("Immediate — before any pilot conversation"):
#126 is a core function currently dead, #127 is an audit/compliance side-door — both outrank
the remaining items on pilot risk. #120/#123–#125/#128/#129 keep their original relative
order behind them. **Actual merge order slipped**: #120 (PR #139) merged 2026-07-09, ahead of
#127 — both #126 (PR #138) and #120 (PR #139) were in the same review session and merged the
same day, so #120 landed before #127 was picked up rather than after, per the queue order
documented in this section. #127 is still the next item to pick up.

- [x] [#121](../../issues/121) RLS under real role: `withTenantContext` sets `app.tenant_id` GUC but never `SET LOCAL ROLE app_user`. Add `SET LOCAL ROLE app_user` or `ALTER TABLE … FORCE ROW LEVEL SECURITY` so RLS is enforced regardless of connection role. — Closed via PR #135 (`b7174c4`, `74ea1ab`, `11156f2`); `withTenantContext`/`executeRawInTenantContext` issue `SET LOCAL ROLE app_user` (`packages/db/src/middleware.ts:25,40`, `packages/db/src/client.ts:28`).
- [x] [#122](../../issues/122) Isolation tests skipped: the three cross-tenant RLS tests are `.skip` because CI runs as superuser. Run CI isolation suite as `app_user` so the isolation guarantee is actually proven. (depends on #121) — Closed alongside #121; see 2026-07-07 PROGRESS.md entry (assertions un-skipped and passing).
- [x] [#126](../../issues/126) `entity.created` / `entity.assigned` triggers never fire: defined in `event-schemas.ts` but entity engine never emits them to the outbox. — ✅ Done, PR #138 (2026-07-09)
- [ ] [#127](../../issues/127) `setEntityState` / `bulkSetState` are unguarded state side-doors: mutate `current_state` directly with no `workflow_events` row and no outbox event.
- [x] [#120](../../issues/120) Automation double-trigger: `transition` action writes outbox + calls inline, depth resets to 0 on outbox path → `MAX_DEPTH` never fires in loops. Fix: carry `depth` through outbox payload or deduplicate by idempotency key. — Closed via `2369723` (depth carried through outbox payload) and PR #139's revised fix (skip the outbox write entirely for automation-triggered transitions).
- [x] [#123](../../issues/123) Automation queue retries: `automation` BullMQ queue has `attempts=1` (BullMQ default). Add `attempts: 3, backoff: { type: "exponential" }` to match the SLA queue. — Closed via `2369723` (`apps/worker/src/queues.ts:17-23`); a prior PR #145 review round disputed this claim, but re-verified directly against current code (`automationQueue`'s `defaultJobOptions: { attempts: 3, backoff: {...} }`, explicitly commented "See issue #123") — the fix is genuinely present.
- [x] [#124](../../issues/124) Auth middleware write-on-every-request: `packages/auth/src/middleware.ts:154-169` does `onConflictDoUpdate` (not `onConflictDoNothing`) on every authenticated request — HOT update per request at scale. — Closed via `2c44411`: SELECT-then-conditionally-write, only inserts/updates on new user or profile drift (verified: the `onConflictDoUpdate` call is gated behind an early-return when `existing.email`/`existing.displayName` already match).
- [ ] [#125](../../issues/125) `notify` action is a stub: `actions/notify.ts` only logs. Wire Novu delivery worker to close the notification loop.
- [ ] [#128](../../issues/128) OpenBao + MinIO commented out of `docker-compose.yml`: the code expects them but `docker compose up` doesn't start them. Uncomment and reconcile with `.env.example`.
- [ ] [#129](../../issues/129) Worker has no health endpoint: orchestrators cannot health-check `apps/worker`. Add an HTTP readiness probe.

Related but not part of the original #120–#129 backlog: [#141](../../issues/141) `pnpm lint`
is a repo-wide no-op (discovered during the #126 review round) — needs its own session to add
real lint scripts to every `package.json`.

**Delivery has guardrails (Claude Code only; plain git + CI unaffected).** Every change runs
Plan → Code → Review → Docs → Ship: freeze + **you approve** an acceptance-criteria plan-lock
(`/spec-tasks` or the `openwind-loop` pick step) before editing source; all edits then one `/review`;
then docs are updated alongside the change (`write-docs-marker.sh --touched`) or the commit
explicitly records why this diff needs none (`--skip "<reason>"`) — no silent third option; the
commit procedure runs `typecheck+lint+test+test:isolation`, writes the commit marker, and opens a
structured PR. The hooks are **guardrails, not barricades** — best-effort speed bumps that catch
honest mistakes; they are not a security boundary (a determined agent can bypass them). The real
enforcement is CI + required human PR review + branch protection. See
[.claude/README.md](.claude/README.md) and [definition-of-done.md](.claude/references/definition-of-done.md).

**Off-limits (never touch autonomously):**

- Parallel approval code — deferred to Phase 3
- ADR files in `docs/decisions/` — humans write these
- Schema cache / `redis.keys()` fix — deferred until load testing

---

## Repository layout

```
apps/
  api/          Hono API server
  worker/       BullMQ background workers
  admin-ui/     Refine + shadcn/ui — single app serving both agent/admin and customer
                users (port 3001), RBAC-controlled internally. There is no separate
                portal app — `apps/portal` on disk is stale/unused, kept only pending
                cleanup (see docker-compose.yml's comment on the admin-ui service).
packages/
  db/           Drizzle schema, migrations, client
  entity-engine/
  workflow-engine/
  automation-engine/
  auth/         Zitadel JWT + RBAC helpers
  notifications/ Novu wrapper
  files/        S3/MinIO presigned URL service
  audit/        Append-only audit log
  config/       Zod-validated env vars — import from @platform/config
  logger/       Structured pino logger
  secrets/      OpenBao client
  connector-sdk/ Third-party connector scaffold (Phase 3)
  plugin-sdk/   Plugin extension points (Phase 3)
  ui/           Shared design system (shadcn/ui + tokens)
  ai/           Anthropic SDK wrapper + RAG helpers
modules/        Seed SQL + one-line stub index.ts per module (no domain logic TypeScript)
tests/
  integration/  Cross-package integration tests
  isolation/    Tenant RLS tests — run on every db/ PR
  e2e/          Full API end-to-end tests
```

---

## Dependency rule (enforced by ESLint — CI fails on violations)

```
apps/*             → packages/*
modules/*          → packages/*   (no cross-module imports ever)
entity-engine      → db only
workflow-engine    → db, entity-engine
automation-engine  → db, workflow-engine, entity-engine
```

Cross-module communication: event bus, entity engine relations API, or tRPC only.

---

## Commands

```bash
pnpm dev              # start all services with hot reload
pnpm test             # unit + integration tests
pnpm test:isolation   # RLS isolation tests  (requires Docker/OrbStack stack)
pnpm test:e2e         # end-to-end API tests (requires Docker/OrbStack stack)
pnpm typecheck        # TypeScript check all packages
pnpm lint             # ESLint, max-warnings=0
pnpm db:migrate       # run pending migrations
pnpm db:seed          # seed development data
docker compose up -d  # start Postgres, Redis, MinIO, OpenBao, Zitadel, Novu
```

macOS: use OrbStack (not Docker Desktop). Windows: run isolation/e2e in CI or WSL2.
Full setup: `docs/local-setup.md`

---

## Rules index (`.claude/rules/` — all auto-loaded)

| File                     | Scope                             | What it covers                                                 |
| ------------------------ | --------------------------------- | -------------------------------------------------------------- |
| `code-style.md`          | always                            | TypeScript, Zod, naming, API patterns, error handling, logging |
| `agent-behaviour.md`     | always                            | Loop procedure, session workflow, exit condition, skills       |
| `git-conventions.md`     | always                            | Branch names, commit format, PR checklist                      |
| `db-conventions.md`      | `packages/db/**`, `*.sql`         | Drizzle, migrations, RLS, analytics annotations                |
| `testing-conventions.md` | `**/*.test.ts`, `tests/**`        | Test layout, naming, isolation suite mandate                   |
| `security.md`            | `apps/api/**`, `packages/auth/**` | 7 non-negotiable security rules                                |

---

## When stuck

1. Check the relevant ADR in `docs/decisions/` — the decision and reasoning are there
2. Check existing tests — they document expected behavior precisely
3. Check `.claude/context/` for domain-specific guides (entity-engine.md, workflow-engine.md, automation-engine.md)
4. Check `docs/sup-docs/roadmap-tracker.md` — understand the phase context before changing scope
5. If a decision isn't covered by an ADR, write one before implementing

---

## Maintenance notes

**Dep bumps:** The `esbuild` override pin (`>=0.28.1`) is for GHSA-gv7w-rqvm-qjhr
(esbuild < 0.28.1, high severity). Do not remove it — tsx@4.x and vite@6.x both pull in the
vulnerable version transitively. Lives in `pnpm-workspace.yaml`'s `overrides:` key (moved
from `package.json`'s `pnpm.overrides` field when pnpm was upgraded to v11 — that field is
no longer read).

---

@.claude/context/phase-2-primer.md
