# CLAUDE.md — Platform Engineering Context

Loaded automatically at the start of every session.
Detailed rules live in `.claude/rules/` and auto-load — see the index below. The two Phase
primers are the exception — see "Phase primers" near the bottom: load on demand, not automatic.

---

## What we are building

A modular, workflow-native business platform. Every module (CRM, helpdesk, HRMS,
reimbursements, etc.) is a configuration of three shared engines: Entity Engine,
Workflow Engine, Automation Engine. Modules are seed SQL + one-line stub index files —
no domain logic TypeScript in `modules/`.

Reference docs (read before starting work in a new area):

- `docs/architecture-brief.md` — full platform architecture
- `docs/decisions/ADR-001-multitenancy.md` — tenancy model and RLS
- `docs/decisions/ADR-002-workflow-engine.md` — state machine design
- `docs/decisions/ADR-003-field-validation.md` — entity validation
- `docs/decisions/ADR-004-config-first-module-design.md` — config-first module model; the
  ADR most directly relevant to module authoring decisions (zero TypeScript in
  `modules/` — read this before touching anything under `modules/`)
- `docs/decisions/ADR-005-module-optionality-and-tender.md` — `tender` module scope
  (`modules.category = 'optional'`); read before changing module category/auto-provisioning logic
- `docs/decisions/ADR-006-per-workflow-ownership-admin-model.md` — per-workflow ownership/admin
  model, including the accepted v1 gap (transition guards don't consult per-instance
  `__accessUsers` grants); read before touching workflow ownership or access-grant logic
- `docs/decisions/ADR-007-rls-workflow-config-tables.md` — RLS for entity_types/workflows/
  workflow_states/workflow_transitions; read before touching RLS policies on these four tables
  or `apps/worker/src/tenant-purge.ts`'s workflow-state/transition deletion path
- `docs/decisions/ADR-008-api-key-credential-lifecycle-hardening.md` — `api_key` audit/expiry/
  rotation/soft-revoke and the `scopes` re-shape; read before touching `api_keys` or Phase 3A
  connector/partner auth
- `docs/decisions/ADR-009-connector-runtime-webhook-gateway-architecture.md` — connector runtime,
  webhook gateway, outbound delivery; read before starting any Phase 3A connector work
- `docs/decisions/ADR-010-inbound-partner-api-integration.md` — inbound partner API (Tier 1
  only — Tier 2 deferred); read before touching the public/partner-facing API surface
- `docs/decisions/ADR-011-plugin-system.md` — plugin system (Module Federation, slot registry,
  lifecycle service); read before touching `packages/plugin-sdk` or plugin install/uninstall
  routes. Two known gaps tracked in the ADR itself (no wrapped DB client/governor limits wired,
  no plugin can run backend code yet — only migrations execute) — see issue #433.
- `docs/decisions/ADR-012-third-party-api-ticket-access.md` — third-party API access to tickets
  (dual-identity auth, action-scopes, presigned attachment uploads); read before touching the
  Phase A–G third-party API implementation (`docs/third-party-api-design.md` is the canonical
  behavioral detail). See issue #471 for a governance note on how this ADR was accepted.
- `docs/decisions/ADR-013-unified-rate-limiting-strategy.md` — platform-wide rate-limiting tiers
  (per-key-and-person / per-key / per-tenant); read before touching `packages/redis/src/rate-limit.ts`,
  `apps/api/src/middleware/rate-limit.ts`, or `packages/auth/src/middleware.ts`'s rate-limit checks.
- `docs/decisions/ADR-014-notification-sla-retry-escalation.md` — notification retry/exhaustion
  policy; read before touching `apps/worker/src/notification-*.ts` or `alert-worker.ts`.
- `docs/sup-docs/roadmap-tracker.md` — phase progress and track status
- `docs/sup-docs/week-log/` — running velocity log, one file per session (see its README —
  never edit `week-log.md` itself, it's frozen history as of 2026-08-13)

---

## Current focus

**Phase:** 3 — Scale & Extensibility (3A **in progress**, 3B **done** — ADR-008/009/010 accepted
2026-08-06; 3A Stage 0 + Stage 1 done, Stage 2 runtime + scopes tracks landing; 3B shipped
2026-08-13 via PR #397 (all 3 phases) — see `docs/sup-docs/roadmap-tracker.md` for the current %,
not repeated here since it drifts)
**Phase 2 status:** ✅ Complete as of 2026-06-18 (all 4 tracks + pre-pilot hardening merged)

Phase 3 tracks (3A in progress, 3B done; 3C/3D/3-OPS still 0% — no active work yet; starting
either is a human scope call — no ADR exists for either yet — consistent with
`agent-behaviour.md`'s general "no phase advance without explicit sign-off" rule, not a
3C/3D-specific one):

| ID    | Track                                               | Notes                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3A    | Integration layer — connector runtime, marketplace  | 🟡 In progress. Stage 0/1 done, Stage 2 runtime + scopes tracks landing. Detailed sequence + status in `.claude/context/phase-3-primer.md`; live % in `docs/sup-docs/roadmap-tracker.md` — update both there, not here. |
| 3B    | Plugin system — Module Federation, slot registry    | ✅ Done — PR #397 (2026-08-13), all 3 phases.                                                                                                                                                                           |
| 3C    | AI layer — automation gen, workflow suggestion, RAG | Not yet started; no ADR yet — a human scope call, not a 3B-blocked dependency                                                                                                                                           |
| 3D    | Observability + compliance — OTel, Prometheus, GDPR | Parallel with 3A–3C possible                                                                                                                                                                                            |
| 3-OPS | Deferred ops/infra concerns                         | See Phase 1 carry-overs in tracker                                                                                                                                                                                      |

New findings from any review go through
[docs/reviews/pending-review-findings.md](docs/reviews/pending-review-findings.md) — file an
issue before picking one up, not a standing checklist in this file. (The pre-Phase-3 hardening
round and the 2026-07-16/21 reconciliation that used to be summarized here are both fully closed;
see `docs/sup-docs/week-log/2026-08-19-claude-md-hardening-checklist-archive.md` for that history
verbatim, and ADR-005/ADR-006 above for the decisions that came out of it.)

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

- Parallel approval code — off-limits regardless of Phase 3 progress; no track (3A/3B done,
  3C/3D unstarted) currently owns building this — see
  `.claude/context/parallel-approval-pattern.md` and issue #65
- ADR files in `docs/decisions/` — humans write these
- Schema cache / `redis.keys()` fix — deferred until load testing (issue #4)

---

## Repository layout

```
apps/
  api/          Hono API server
  worker/       BullMQ background workers
  admin-ui/     Refine + shadcn/ui — single app serving both agent/admin and customer
                users (port 3001), RBAC-controlled internally. There is no separate
                portal app — `apps/portal` source was removed in PR #211; the directory
                exists only as a pnpm workspace stub.
packages/
  db/           Drizzle schema, migrations, client
  entity-engine/
  workflow-engine/
  automation-engine/
  auth/         Zitadel JWT + RBAC helpers
  notifications/ Novu wrapper
  files/        Tenant-scoped local-disk file storage + async ClamAV scanning (PR #340;
                replaced the earlier S3/MinIO presigned-URL design)
  audit/        Append-only audit log
  config/       Zod-validated env vars — import from @platform/config
  logger/       Structured pino logger
  redis/        Shared ioredis client + rate-limit helper (@platform/redis)
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

Same rule, also checkable on the full transitive graph (not just per-file import specifiers)
via `pnpm dep:check` — see `.claude/context/dependency-graph.md`.

---

## Commands

**Everything containerized — nothing runs on the host.** `docker compose up -d` starts the
default stack (Postgres, PgBouncer, Redis, OpenBao, Zitadel, ClamAV, `ow-backend`,
`ow-frontend`, and `ow-worker`) — this is the standard way to run the app, in dev and on
servers alike. Novu is opt-in via `--profile notifications` (`novu-api`/`novu-worker`/
`novu-web`/`novu-mongo`) — a plain `up -d` does not start it. MinIO is fully commented out —
`packages/files` moved to local-disk storage + real ClamAV scanning (PR #340); MinIO is kept in
`docker-compose.yml` only as reference for a possible future return to object storage, nothing
reads from it today. `ow-worker` runs `apps/worker` (outbox poller, automation execution, SLA
scheduler, notifications, file cleanup, AV scan) as its own container, same as
`ow-backend`/`ow-frontend`. This was discovered missing on the first server deployment
(2026-07-25) — a plain `docker compose up -d` had never included it, so BullMQ jobs queued but
nothing ever consumed them.
`pnpm dev` (turbo, host-mode hot reload) still works for fast local iteration, but it runs
services directly on the host — it is not what CI or servers do, and using it as your only
local dev flow is how gaps like the missing worker container go unnoticed until production.
Prefer `docker compose up -d` unless you specifically need host-mode hot reload for a
tight edit-test loop.

```bash
docker compose up -d                          # default stack — Postgres, PgBouncer, Redis,
                                               # OpenBao, Zitadel, ClamAV, ow-backend/frontend/worker
docker compose --profile notifications up -d  # + Novu (novu-api/worker/web/mongo)
pnpm dev              # host-mode hot reload (fast iteration only — see note above)
pnpm test             # unit + integration tests
pnpm test:isolation   # RLS isolation tests  (requires Docker/OrbStack stack)
pnpm test:e2e         # end-to-end API tests (requires Docker/OrbStack stack)
pnpm typecheck        # TypeScript check all packages
pnpm lint             # ESLint, max-warnings=0
pnpm db:migrate       # run pending migrations
pnpm db:seed          # seed development data
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
4. Need to know what depends on a file before changing it? `pnpm dep:impact -- '<path-regex>'`
   gives a transitive answer grep can't — but a stale `dist/` makes it silently
   under-report, so treat an empty result as inconclusive, not "nothing depends on this",
   and cross-check with grep before trusting it — see `.claude/context/dependency-graph.md`
5. Check `docs/sup-docs/roadmap-tracker.md` — understand the phase context before changing scope
6. If a decision isn't covered by an ADR, write one before implementing

---

## Maintenance notes

**Dep bumps:** All security override pins live in `pnpm-workspace.yaml`'s `overrides:` key
(moved from `package.json`'s `pnpm.overrides` field when pnpm was upgraded to v11 — that
field is no longer read). Do not remove these:

- `esbuild >=0.28.1` — GHSA-gv7w-rqvm-qjhr (high); tsx@4.x and vite@6.x pull in the
  vulnerable version transitively.
- `hono >=4.12.34` — GHSA-8j4g-w8fx-2239 (ReDoS in CORS middleware via
  Access-Control-Request-Headers). Also the source of truth for the minimum hono version
  workspace-wide (#182) — individual `package.json` hono specifiers should match this floor.
- `turbo >=2.9.14` — GHSA-3qcw-2rhx-2726 (unexpected local code execution during Yarn Berry
  detection).
- `"@babel/core" >=7.29.1` — GHSA-4x5r-pxfx-6jf8 (arbitrary file read via sourceMappingURL
  comment).
- `"brace-expansion" ">=5.0.9"` — GHSA-3jxr-9vmj-r5cp / GHSA-52cp-r559-cp3m /
  GHSA-mh99-v99m-4gvg (DoS via unbounded expansion); blanket pin covers all major lines.
  Bumped from `>=5.0.8` for GHSA-rgw5-rvv9-x895 (2026-08-03) — the 5.0.8 mitigation only
  bounded the final combine() step, not two intermediate arrays built before it.
- `"js-yaml@4" "4.3.1"` — quadratic CPU via merge-key chains (>=4.0.0 <4.3.0) and
  `!!omap` tag resolution (GHSA-5p4m-2wfm-xmqj / CVE-2026-59870, 2026-08-07);
  bumped from `4.3.0` on 2026-08-07.
- `"fast-uri" ">=3.1.4 <4.0.0 || >=4.1.2"` — GHSA-4c8g-83qw-93j6 / GHSA-v2hh-gcrm-f6hx /
  GHSA-7p8r-x3mc-p8w7 (host confusion via IDN / backslash authority); pulled in via
  commitlint's ajv dep. Range widened from a flat `>=3.1.4` floor to also patch the 4.x line
  once GHSA-7p8r-x3mc-p8w7 landed there too.
- `undici ">=7.29.0 <8"` — GHSA-4cwx-7wf7-3272 / GHSA-m8rv-5g2x-5cg5 / GHSA-jr45-8vmc-qm54 /
  GHSA-v3r7-h72x-cjcm; bounded to `<8` so a major bump doesn't break jsdom's internal file
  imports.
- `postcss ">=8.5.18"` — GHSA-r28c-9q8g-f849 (path traversal via sourceMappingURL
  auto-loading); pulled in via vite (admin-ui devDep).
- `nanoid ">=3.3.17 <4"` — GHSA-2v37-7h3g-55p8 (indefinite loop when size is 0);
  pulled in via postcss (vite/vitest chains in admin-ui devDeps). Bounded to `<4` —
  postcss's own package.json pins nanoid as `^3.x`, so an unbounded floor would
  silently force it onto an untested major (resolves to 6.0.1) instead of just the fix.

---

## Phase primers (load on demand — not imported automatically)

Unlike the rest of this file, these are not read every session — pull the relevant one in only
when the work actually touches that phase, so sessions on unrelated tracks don't pay for content
they won't use.

- Working on Phase 2 legacy surfaces (helpdesk/reimbursements/CRM modules, platform services,
  admin-ui generic views, no-code builders)? Read `.claude/context/phase-2-primer.md` first.
- Working on Phase 3A or later Phase 3 tracks (connector runtime, webhook gateway, `api_keys`,
  `event_subscriptions`, `packages/connector-sdk`)? Read `.claude/context/phase-3-primer.md` first.
