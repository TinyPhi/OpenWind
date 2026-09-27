# CLAUDE.md — Platform Engineering Context

Loaded every session. Rules in `.claude/rules/` auto-load (`code-style`, `agent-behaviour`,
`git-conventions` always; `db-conventions`, `testing-conventions`, `security` when you touch
matching paths).

---

## What we are building

A modular, workflow-native business platform. Every module (CRM, helpdesk, HRMS,
reimbursements, etc.) is a configuration of three shared engines: Entity Engine, Workflow Engine
and Automation Engine. Modules are seed SQL plus a one-line stub `index.ts`, with no domain-logic
TypeScript in `modules/` (ADR-004). Full architecture: `docs/architecture-brief.md`.

## Read before touching

| Area                                                                                                 | Read                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Tenancy, RLS                                                                                         | ADR-001                                                                              |
| Workflow state machine                                                                               | ADR-002, `.claude/context/workflow-engine.md`                                        |
| Entity field validation                                                                              | ADR-003, `.claude/context/entity-engine.md`                                          |
| Anything under `modules/`                                                                            | ADR-004 (config-first)                                                               |
| Module category / auto-provisioning (`tender`, `optional`)                                           | ADR-005                                                                              |
| Workflow ownership / access grants (v1 gap: guards ignore `__accessUsers`)                           | ADR-006                                                                              |
| RLS on entity_types/workflows/workflow_states/workflow_transitions, `tenant-purge.ts` state deletion | ADR-007                                                                              |
| `api_keys` (audit, expiry, rotation, scopes)                                                         | ADR-008                                                                              |
| Connector runtime, webhook gateway, outbound delivery (3A)                                           | ADR-009, `.claude/context/phase-3-primer.md`                                         |
| Public / partner-facing API (Tier 1 only)                                                            | ADR-010                                                                              |
| `packages/plugin-sdk`, plugin install/uninstall                                                      | ADR-011 (known gaps: #644)                                                           |
| Third-party ticket API (Phases A–G)                                                                  | ADR-012, `docs/third-party-api-design.md` (index), `docs/specs/third-party-api-*.md` |
| Rate limiting (`packages/redis/src/rate-limit.ts`, api middleware, auth middleware)                  | ADR-013                                                                              |
| `apps/worker/src/notification-*.ts`, `alert-worker.ts`                                               | ADR-014                                                                              |
| `packages/telemetry`, retention/erasure sweeps                                                       | ADR-015                                                                              |
| Teams/services, on-call schedules, severity + labels, `resolve_oncall`, notification policies (3E)   | ADR-016, `docs/oncall-routing-design.md`                                             |
| `schedule_rules` / `schedule_executions`, scheduler tick (3F)                                        | ADR-017, `docs/temporal-scheduler-design.md`                                         |
| `packages/automation-engine`                                                                         | `.claude/context/automation-engine.md` (always `/security-review`)                   |
| Helpdesk/reimbursements/CRM modules, platform services, admin-ui generic views, no-code builders     | `.claude/context/phase-2-primer.md`                                                  |
| Parallel approval                                                                                    | Off-limits — `.claude/context/parallel-approval-pattern.md`, #65                     |

Status and history: `docs/tracker/roadmap-tracker.md` and `docs/tracker/week-log/`, one file per
session. The frozen pre-2026-08-14 log is `week-log/archive/week-log.md`; never edit it. Specs are
indexed in `docs/specs/README.md`.

`docs/sup-docs/` is **gitignored and local-only** (the owner's strategy, pricing and GTM notes).
Never assume a contributor can see it, never cite it from a tracked doc, and never put tracking
content in it.

---

## Current focus

**Phase 3 — Scale & Extensibility.** Phase 1 ✅ 2026-05-21, Phase 2 ✅ 2026-06-18. PR/issue detail
and live % live **only** in [roadmap-tracker.md](docs/tracker/roadmap-tracker.md). Edit this table
only when a track's headline changes (started / done / blocked).

| ID    | Track                                                           | Headline                                                                                                      |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 3A    | Integration layer — connector runtime, partner API, marketplace | 🟡 Runtime + partner API (ADR-012 A–G) shipped; connectors #368 + marketplace UI #369 not started             |
| 3B    | Plugin system — Module Federation, slot registry                | ✅ Done (#397); 2 known gaps tracked in #644                                                                  |
| 3C    | AI layer — automation gen, workflow suggestion, RAG             | 🔴 Not started, no ADR — human scope call (#18, #614–618)                                                     |
| 3D    | Observability + compliance — OTel, Prometheus, GDPR             | ✅ Done (#503–507, ADR-015)                                                                                   |
| 3E    | On-call routing & severity-based notification                   | 🟡 Phases 1–4 merged (ADR-016); gaps: SMS/WhatsApp/voice delivery, duration metrics, 2 UI badges (#570, #571) |
| 3F    | Temporal scheduler — auto-create tickets on schedule            | 🟡 Phases 1–4 merged (ADR-017); gap: schedule alert rules (#580)                                              |
| 3G    | MIS reporting — embedded Superset + standalone/Zitadel SSO      | 🟡 Stages 1–2 merged (#663–671); isolation ADR not yet written (#695)                                         |
| 3H    | Cross-functional workflow visibility                            | 🟡 Phase 1 in progress — vendor-approval seed module (#606); ADR pending (#622)                               |
| 3-OPS | Deferred ops/infra concerns                                     | 🔴 Not started (#6)                                                                                           |

No phase or track starts without explicit human sign-off. New review findings go through
[docs/reviews/pending-review-findings.md](docs/reviews/pending-review-findings.md); file an issue
before picking one up.

**Delivery:** every change runs Plan → Code → Review → Docs → Ship, guided by hooks documented
once in [.claude/README.md](.claude/README.md). The completion contract is
[definition-of-done.md](.claude/references/definition-of-done.md). The hooks are guardrails, not a
security boundary; CI plus human PR review is the real gate.

**Off-limits (never touch autonomously):** parallel approval code (#65) · ADR files in
`docs/decisions/` (humans write them) · schema cache / `redis.keys()` fix (deferred to load
testing, #4).

---

## Repository layout

```
apps/
  api/            Hono API server
  worker/         BullMQ workers (outbox, automations, SLA, schedule tick, notifications, AV scan)
  admin-ui/       Refine + shadcn/ui — the single UI for agents, admins and customers (RBAC);
                  apps/portal is only a workspace stub (source removed in PR #211)
packages/
  db/             Drizzle schema, migrations, client
  entity-engine/  workflow-engine/  automation-engine/
  auth/           Zitadel JWT + RBAC helpers
  notifications/  Novu wrapper
  files/          Tenant-scoped local-disk storage + async ClamAV scan (no S3 since PR #340)
  audit/          Append-only audit log
  config/         Zod-validated env — import from @platform/config
  logger/         Structured pino logger
  redis/          Shared ioredis client + rate-limit helper
  secrets/        OpenBao client
  connector-sdk/  plugin-sdk/   Phase 3 extension SDKs
  ui/             Shared design system (shadcn/ui + tokens)
  ai/             Anthropic SDK wrapper + RAG helpers
  teams/          Teams/services/on-call primitives + shared cross-tenant FK helper (3E/3F)
  scheduler/      Cron + next-fire, timezone/template validation, cross-tenant ref checks (3F)
  telemetry/      OTel, Prometheus metrics, PII-scrubbed Sentry (3D)
  tsconfig/       Shared TypeScript base configs
modules/          Seed SQL + one-line stub index.ts per module
tests/            integration/ · isolation/ (tenant RLS, every db/ PR) · e2e/
```

## Dependency rule (ESLint-enforced; `pnpm dep:check` checks the transitive graph)

```
apps/*             → packages/*
modules/*          → packages/*   (no cross-module imports ever)
entity-engine      → db only
workflow-engine    → db, entity-engine
automation-engine  → db, workflow-engine, entity-engine, teams, audit
teams              → db only
scheduler          → db, teams, config, logger   (no package-specific boundary rule yet)
```

Cross-module communication goes through the event bus, the entity-engine relations API, or tRPC
only. To check what depends on a file, run `pnpm dep:impact -- '<path-regex>'`. A stale `dist/`
makes it under-report, so treat an empty result as inconclusive and cross-check with grep (see
`.claude/context/dependency-graph.md`).

---

## Commands

Everything is containerized. `docker compose up -d` is the standard way to run the app, in dev and
on servers alike. It starts Postgres, PgBouncer, Redis, OpenBao, ClamAV, `ow-backend`,
`ow-frontend` and `ow-worker`. Zitadel is a separate compose project (`../zitadel/`, joined via the
external `openwind_zitadel` network). `pnpm dev` is host-mode hot reload for tight loops only; it
is not what CI or servers run.

```bash
docker compose up -d                          # default stack
docker compose --profile notifications up -d  # + Novu
docker compose --profile observability up -d  # + Prometheus/Grafana/Alertmanager/OTel collector
docker compose --profile reporting up -d      # + Superset (3G)   (also: tools, bootstrap)
pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation   # exit condition
pnpm test:e2e         # end-to-end API tests (needs the stack)
pnpm db:migrate       # run pending migrations
pnpm db:seed          # seed development data
```

macOS: OrbStack, not Docker Desktop. Windows: run isolation/e2e in CI or WSL2. Full setup:
`docs/local-setup.md`.

---

## When stuck

1. Read the relevant ADR, then the existing tests — they document expected behavior precisely.
2. Check `.claude/context/` for the engine guide.
3. Check `docs/tracker/roadmap-tracker.md` before changing scope.
4. If a decision isn't covered by an ADR, stop and write it up in BLOCKERS.md. ADRs are
   human-authored, so a human writes the ADR before you implement.

**Dep bumps:** every security override pin lives in `pnpm-workspace.yaml` `overrides:` (pnpm v11
ignores `package.json`'s `pnpm.overrides`), with its advisory and rationale as an inline comment
plus a "Deferred" block. Never remove a pin without reading its comment. Record new advisories
there, not here.
