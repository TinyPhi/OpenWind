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
- `docs/sup-docs/roadmap-tracker.md` — phase progress and track status
- `docs/sup-docs/week-log.md` — running velocity log (update each session)

---

## Current focus

**Phase:** 3 — Scale & Extensibility (3A planning complete — ADR-008/009/010 accepted
2026-08-06; implementation not started)
**Phase 2 status:** ✅ Complete as of 2026-06-18 (all 4 tracks + pre-pilot hardening merged)

Phase 3 tracks (all 0% — no active work yet):

| ID    | Track                                               | Notes                                                                                                                                                               |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3A    | Integration layer — connector runtime, marketplace  | ADR-008/009/010 accepted. Implementation sequence in `.claude/context/phase-3-primer.md`, staged: ADR-008 core → ADR-009 runtime + ADR-008 scopes → ADR-010 Tier 1. |
| 3B    | Plugin system — Module Federation, slot registry    | After 3A                                                                                                                                                            |
| 3C    | AI layer — automation gen, workflow suggestion, RAG | After 3B                                                                                                                                                            |
| 3D    | Observability + compliance — OTel, Prometheus, GDPR | Parallel with 3A–3C possible                                                                                                                                        |
| 3-OPS | Deferred ops/infra concerns                         | See Phase 1 carry-overs in tracker                                                                                                                                  |

**Pre-Phase 3 hardening (external review flagged) — status as of 2026-07-24:**

These were correctness/safety fixes in existing code, not Phase 3 features. **Only #125 remains
open** — see [docs/reviews/pending-review-findings.md](docs/reviews/pending-review-findings.md)
for it and every other still-open finding from the original review round (the four dated review
docs this consolidates were removed 2026-07-24; their resolved findings aren't repeated here).

- [x] #121 RLS under real role (`SET LOCAL ROLE app_user`) — PR #135
- [x] #122 Isolation tests run as `app_user`, not superuser — alongside #121
- [x] #126 `entity.created`/`entity.assigned` triggers never fired — PR #138
- [x] #127 `setEntityState`/`bulkSetState` unguarded state side-door — PR #155. Follow-up gap
      it surfaced (no `workflow_states` validation) was filed as #160 and closed via PR #180
      (2026-07-24).
- [x] #120 Automation double-trigger (depth resets on outbox path) — PR #139
- [x] #123 Automation queue had no retries — `2369723`
- [x] #124 Auth middleware wrote on every request — `2c44411`
- [x] #128 OpenBao + MinIO commented out of `docker-compose.yml` — PR #173 (2026-07-23),
      idempotency follow-up PR #188 (2026-07-24)
- [x] #129 Worker has no health endpoint — PR #175 (2026-07-24)
- [x] #141 `pnpm lint` was a repo-wide no-op — PR #166
- [x] #136 RLS for `entity_types`/`workflows`/`workflow_states`/`workflow_transitions` — ADR-007
      accepted 2026-07-24; implementation in PR #181 (open, awaiting review)
- [x] **#125** `notify` action wired end-to-end — outbox-pattern delivery worker, in-app inbox,
      WebSocket live push, pluggable outbound seam — PR #211 (2026-07-29).

See [docs/sup-docs/roadmap-tracker.md](docs/sup-docs/roadmap-tracker.md) for the fuller,
actively-maintained backlog table (includes #143, #160–#171 follow-ons, and PR-in-review status).

**Shipped 2026-07-16 to 2026-07-21 — now formally ratified.** PR #144 (2026-07-16 — child
tickets, the `modules/tender` vertical, an access-request/grant authorization layer) and PRs
#151/#152/#155 (2026-07-21 — Zitadel org-id→tenant mapping, a request-access UI, the
per-workflow ownership/admin model) landed outside the `openwind-loop` process and sat
unclassified until 2026-07-22's reconciliation flagged two open questions. Both are now
resolved:

1. **Per-workflow ownership/admin model → ADR-006** (accepted 2026-07-24). Permanent, accepted
   policy. Its own noted gap — transition guards not consulting per-instance `__accessUsers`
   grants — remains an accepted v1 limitation, not yet its own issue.
2. **`tender` module scope → ADR-005** (accepted 2026-07-23). `tender` is the platform's 8th
   module, classified `optional` (the `modules.category` column and auto-provisioning shipped
   via PR #342, 2026-08-06, closing #165).

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
                portal app — `apps/portal` source was removed in PR #211; the directory
                exists only as a pnpm workspace stub.
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

**Everything containerized — nothing runs on the host.** `docker compose up -d` starts the
complete stack (Postgres, Redis, MinIO, OpenBao, Zitadel, Novu, `ow-backend`, `ow-frontend`,
and `ow-worker`) — this is the standard way to run the app, in dev and on servers alike.
`ow-worker` runs `apps/worker` (outbox poller, automation execution, SLA scheduler,
notifications, file cleanup, AV scan) as its own container, same as `ow-backend`/`ow-frontend`.
This was discovered missing on the first server deployment (2026-07-25) — a plain `docker
compose up -d` had never included it, so BullMQ jobs queued but nothing ever consumed them.
`pnpm dev` (turbo, host-mode hot reload) still works for fast local iteration, but it runs
services directly on the host — it is not what CI or servers do, and using it as your only
local dev flow is how gaps like the missing worker container go unnoticed until production.
Prefer `docker compose up -d` unless you specifically need host-mode hot reload for a
tight edit-test loop.

```bash
docker compose up -d  # start the full stack — Postgres, Redis, MinIO, OpenBao, Zitadel,
                       # Novu, ow-backend, ow-frontend, ow-worker
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
4. Check `docs/sup-docs/roadmap-tracker.md` — understand the phase context before changing scope
5. If a decision isn't covered by an ADR, write one before implementing

---

## Maintenance notes

**Dep bumps:** All security override pins live in `pnpm-workspace.yaml`'s `overrides:` key
(moved from `package.json`'s `pnpm.overrides` field when pnpm was upgraded to v11 — that
field is no longer read). Do not remove these:

- `esbuild >=0.28.1` — GHSA-gv7w-rqvm-qjhr (high); tsx@4.x and vite@6.x pull in the
  vulnerable version transitively.
- `"brace-expansion" ">=5.0.9"` — GHSA-3jxr-9vmj-r5cp / GHSA-52cp-r559-cp3m /
  GHSA-mh99-v99m-4gvg (DoS via unbounded expansion); blanket pin covers all major lines.
  Bumped from `>=5.0.8` for GHSA-rgw5-rvv9-x895 (2026-08-03) — the 5.0.8 mitigation only
  bounded the final combine() step, not two intermediate arrays built before it.
- `"js-yaml@4" "4.3.1"` — quadratic CPU via merge-key chains (>=4.0.0 <4.3.0) and
  `!!omap` tag resolution (GHSA-5p4m-2wfm-xmqj / CVE-2026-59870, 2026-08-07);
  bumped from `4.3.0` on 2026-08-07.
- `"fast-uri" ">=3.1.4"` — GHSA-4c8g-83qw-93j6 / GHSA-v2hh-gcrm-f6hx (host confusion
  via IDN / backslash authority); pulled in via commitlint's ajv dep.
- `postcss ">=8.5.18"` — GHSA-r28c-9q8g-f849 (path traversal via sourceMappingURL
  auto-loading); pulled in via vite (admin-ui devDep).
- `nanoid ">=3.3.17 <4"` — GHSA-2v37-7h3g-55p8 (indefinite loop when size is 0);
  pulled in via postcss (vite/vitest chains in admin-ui devDeps). Bounded to `<4` —
  postcss's own package.json pins nanoid as `^3.x`, so an unbounded floor would
  silently force it onto an untested major (resolves to 6.0.1) instead of just the fix.

---

@.claude/context/phase-2-primer.md
@.claude/context/phase-3-primer.md
