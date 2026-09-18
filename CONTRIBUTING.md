# Contributing to OpenWind

Thank you for your interest in contributing. Phase 1 (the engine layer) and Phase 2 (the first
customer-ready apps) are both done — OpenWind is now in Phase 3 (scale & extensibility), with
several tracks running in parallel: connector runtime, plugin system (done), AI layer,
observability/compliance (done), on-call routing, a temporal scheduler, reporting dashboards, and
cross-functional workflow visibility. See [`docs/tracker/roadmap-tracker.md`](docs/tracker/roadmap-tracker.md)
for the live, per-track status — it changes often, so treat any phase description here as a
snapshot, not current truth.

---

## Before you start

1. **Read [`CLAUDE.md`](CLAUDE.md)** — engineering conventions enforced by CI (naming, TypeScript strictness, security rules, testing requirements). Not optional reading.
2. **Read the relevant ADR(s)** in [`docs/decisions/`](docs/decisions/) for the area you're working in. The ADRs explain _why_ things are the way they are — they prevent you from re-litigating settled decisions in a PR.
3. **Check the [roadmap tracker](docs/tracker/roadmap-tracker.md)** (and `CLAUDE.md`'s Current Focus) to understand which phase a component belongs to and what it depends on. Phase 2 components cannot be built without Phase 1 being solid.
4. **Know the [Contribution Terms](#contribution-terms) before your first PR** — submitting one means agreeing to them (or to [`CLA.md`](CLA.md) directly), so it's worth reading once up front rather than discovering it in the PR template.

---

## What to work on

### Currently open work

Phase 1's five foundational component issues (#7–#11) are long since closed — Phase 1 and Phase 2
are both complete. For what's actually open right now, don't rely on a hardcoded list in this
file (it will go stale exactly like the old Phase 1 list did) — instead:

1. Check [`docs/tracker/roadmap-tracker.md`](docs/tracker/roadmap-tracker.md) for the current
   Phase 3 track breakdown and each track's open issues.
2. Browse [open issues](https://github.com/TinyPhi/OpenWind/issues) filtered by the `phase-3`
   label, or by a specific track prefix in the title (`[3A]`, `[3C]`, `[3E]`, `[3F]`, `[3G]`,
   `[3H]`).
3. Read `CLAUDE.md`'s "Current focus" section for which tracks are actively being worked on
   versus which are intentionally not started yet (starting a new track is a scope decision, not
   something to pick up unprompted).

### Good first issues

Issues tagged [`good first issue`](https://github.com/TinyPhi/OpenWind/issues?q=is%3Aopen+label%3A%22good+first+issue%22) are scoped to be completable without deep platform knowledge. They're a good way to get familiar with the codebase before tackling an engine component.

### Proposing new work

For significant contributions — new engine capabilities, new module types, changes to existing ADRs — open a discussion issue before writing code. The discussion should cover: what problem you're solving, why the current design doesn't solve it, and what you're proposing. This prevents wasted effort on approaches that conflict with existing decisions.

---

## Local setup

### Prerequisites

- Node.js 22+
- pnpm 11+ (`packageManager` in `package.json` pins the exact version)
- Docker (OrbStack recommended on macOS, not Docker Desktop) and Docker Compose

### First-time setup

The fastest path is the one-command bootstrap — see the root [`README.md`](README.md)'s
"Quick start" section (`pnpm install --frozen-lockfile && pnpm bootstrap`), which handles
`.env.local` creation, the full Docker stack, migrations, seed data, and Zitadel configuration
automatically. Manual step-by-step, if you need more control:

```bash
git clone https://github.com/TinyPhi/OpenWind.git
cd OpenWind

cp .env.example .env.local
# Edit .env.local — defaults work for local dev, no changes needed unless noted

docker compose up -d
# Starts the default stack: Postgres, PgBouncer, Redis, OpenBao, Zitadel,
# ClamAV, ow-backend, ow-frontend, ow-worker.
# Novu (email/in-app notifications) is opt-in: docker compose --profile notifications up -d
# Observability (Prometheus/Grafana/Alertmanager) is opt-in: docker compose --profile observability up -d
# There is no MinIO or MailHog in the current stack — file storage moved to
# local disk + ClamAV scanning (PR #340), and there's no local SMTP sandbox today.

pnpm install
pnpm db:migrate
pnpm db:seed
```

Everything runs in containers — `pnpm dev` (Turborepo, host-mode hot reload) is available for a
tight edit-test loop, but prefer `docker compose up -d` as your default; see `CLAUDE.md`'s
Commands section for why (a missing container has caused a real production gap before).

| Service         | URL                        | Default credentials               |
| --------------- | -------------------------- | --------------------------------- |
| Admin UI        | http://localhost:3001      | Zitadel login                     |
| API + docs      | http://localhost:3000/docs | —                                 |
| Zitadel console | http://localhost:8080      | admin@platform.local / Admin1234! |
| OpenBao UI      | http://localhost:8200      | Token: `dev-root-token`           |

### Running tests

```bash
pnpm test                  # all unit tests
pnpm test:isolation        # RLS tenant isolation tests (run these if you touch db/)
pnpm test:e2e              # full API end-to-end tests
pnpm typecheck             # TypeScript strict check across all packages
pnpm lint                  # ESLint
```

The isolation tests are mandatory before any PR that adds or changes a table or API route. Run them locally first — they're the ones most likely to catch tenant data leakage.

---

## The config-first rule

This is the most important architectural constraint to understand before contributing.

**Modules are configuration, not code.** The three engines (Entity, Workflow, Automation) are written once. A new business module is a seed SQL file — INSERT statements into `entity_types`, `entity_fields`, `workflow_states`, `workflow_transitions`, and `automation_rules`. It has no backend TypeScript.

Before writing any module-related code, ask:

- Can this be expressed as rows in an existing table? → write seed SQL, not TypeScript
- Is this business logic in TypeScript? → should it be an `automation_rules` row?
- Is this a workflow definition in TypeScript? → move it to `workflow_states` + `workflow_transitions` rows
- Does this require a new API route? → is it actually a new engine primitive?
- Does this UI require a new page? → can the generic entity list/detail/form handle it with different field config?

If you need something the engines can't express, the answer is an **engine PR** (new trigger type, new action type, new field type) — not module-level code. Write an ADR entry, get it reviewed, then build it in the engine with tests.

Full decision and checklist: [ADR-004 — Config-First Module Design](docs/decisions/ADR-004-config-first-module-design.md)

---

## Workflow

### Branch naming

```
feat/PLAT-123-short-description
fix/PLAT-456-what-was-broken
chore/PLAT-789-what-changed
docs/PLAT-012-what-was-documented
test/PLAT-345-what-is-tested
```

If there's no issue number yet, omit it: `feat/entity-bulk-operations`.

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(workflow): add parallel approval state machine pattern
fix(entity): invalidate schema cache on field delete
chore(deps): upgrade hono to 4.x
test(isolation): add RLS tests for workflow_events table
docs(adr): record decision on field validation strategy
```

The scope in parentheses is the package or component (`workflow`, `entity`, `auth`, `db`, `api`, `worker`, `admin-ui`, `portal`).

### Opening a PR

1. Open a draft PR as soon as you have working code — even if incomplete. This lets reviewers see direction early.
2. Fill out the [PR template](.github/pull_request_template.md) fully. The checklist items are there because they've caught real bugs.
3. Link to the relevant issue with `Closes #N`.
4. Mark the PR ready for review when the checklist is fully satisfied.

### PR checklist summary

Every PR must:

- [ ] Include tests — coverage must not drop
- [ ] Pass `pnpm typecheck` and `pnpm lint` with zero errors
- [ ] Follow Conventional Commits

If the PR touches `packages/db/` or adds tables:

- [ ] `tenant_id UUID NOT NULL` on all new tenant-scoped tables
- [ ] RLS enabled + both read and write policies defined
- [ ] `tenant_id` index present
- [ ] Tenant isolation tests added (`tests/isolation/`)
- [ ] Down migration present as a comment in the migration file

If the PR touches `apps/api/` or adds routes:

- [ ] All inputs validated with Zod at the route boundary
- [ ] `requireAuth()` applied
- [ ] Rate limiting configured
- [ ] E2E tests for the new route
- [ ] Tenant isolation tests for the new route

If the PR makes a significant architectural decision:

- [ ] ADR created or updated in `docs/decisions/`

---

## Architecture decision records (ADRs)

Before changing how something fundamental works, check whether an ADR already covers it:

| ADR                                                                                 | Decision                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| [ADR-001](docs/decisions/ADR-001-multitenancy.md)                                   | Multi-tenancy via Postgres RLS                   |
| [ADR-002](docs/decisions/ADR-002-workflow-engine.md)                                | DB-native workflow state machine                 |
| [ADR-003](docs/decisions/ADR-003-field-validation.md)                               | Runtime Zod schema generation from entity fields |
| [ADR-004](docs/decisions/ADR-004-config-first-module-design.md)                     | Modules are config (seed SQL), not code          |
| [ADR-005](docs/decisions/ADR-005-module-optionality-and-tender.md)                  | Module optionality/category, `tender` scope      |
| [ADR-006](docs/decisions/ADR-006-per-workflow-ownership-admin-model.md)             | Per-workflow ownership/admin model               |
| [ADR-007](docs/decisions/ADR-007-rls-workflow-config-tables.md)                     | RLS on workflow config tables                    |
| [ADR-008](docs/decisions/ADR-008-api-key-credential-lifecycle-hardening.md)         | API key lifecycle hardening                      |
| [ADR-009](docs/decisions/ADR-009-connector-runtime-webhook-gateway-architecture.md) | Connector runtime & webhook gateway              |
| [ADR-010](docs/decisions/ADR-010-inbound-partner-api-integration.md)                | Inbound partner API (Tier 1)                     |
| [ADR-011](docs/decisions/ADR-011-plugin-system.md)                                  | Plugin system (Module Federation)                |
| [ADR-012](docs/decisions/ADR-012-third-party-api-ticket-access.md)                  | Third-party API ticket access                    |
| [ADR-013](docs/decisions/ADR-013-unified-rate-limiting-strategy.md)                 | Unified rate-limiting strategy                   |
| [ADR-014](docs/decisions/ADR-014-notification-sla-retry-escalation.md)              | Notification SLA retry/escalation                |
| [ADR-015](docs/decisions/ADR-015-observability-compliance.md)                       | Observability & GDPR compliance                  |
| [ADR-016](docs/decisions/ADR-016-oncall-routing.md)                                 | On-call routing                                  |
| [ADR-017](docs/decisions/ADR-017-temporal-scheduler.md)                             | Temporal scheduler                               |

This table drifts as new ADRs land — if it looks short, check
[`docs/decisions/`](docs/decisions/) directly rather than trusting the count here.

If your change contradicts an ADR, don't work around it — open a discussion to challenge the ADR first. ADRs can be superseded, but that requires explicit agreement, not a quiet bypass.

If your change introduces a new significant decision that isn't covered by an existing ADR, write one. It doesn't need to be long. The important parts are: context (what forced this decision), the decision itself, and the consequences.

---

## Dependency rules

Package dependencies flow strictly downward. This is enforced by ESLint and will fail CI:

```
apps/* → packages/*
modules/* → packages/*  (never modules/* → modules/*)
packages/entity-engine → packages/db only
packages/workflow-engine → packages/db, packages/entity-engine
packages/automation-engine → packages/db, packages/workflow-engine, packages/entity-engine
```

Cross-module communication happens only through:

1. The event bus (publish/subscribe via `packages/automation-engine`)
2. The entity relation API (foreign key lookups between entity types)
3. tRPC procedures exposed by `apps/api`

If you find yourself importing from another module or importing upward in the stack, stop — that's a dependency rule violation and CI will block the merge.

---

## Security

These rules are non-negotiable and reviewed in every PR:

- **Never skip RLS.** Every new table that stores tenant data must have RLS enabled and policies defined.
- **Validate all external input with Zod.** API inputs, webhook payloads, connector data — validated before use.
- **No SQL string construction from user input.** Drizzle parameterized queries only.
- **No secrets in code.** Not in tests, not in comments, not in config files.
- **File access is tenant-scoped and never publicly accessible.** Files live on local disk (`packages/files`) with async ClamAV scanning — not a public bucket, and not S3 (that design was replaced in PR #340).
- **Rate limit all public endpoints.** Default 100 req/min per tenant (10 for auth endpoints).

If you discover a security vulnerability, do not open a public issue. Email [security@tinyphi.com](mailto:security@tinyphi.com) with a description.

---

## Code style

TypeScript strict mode everywhere. Key rules enforced by the compiler and linter:

- No `any` — use `unknown` and narrow with a type guard or Zod parse
- No type assertions without an inline comment explaining why
- Types derived from Zod schemas using `z.infer<>`, never written separately
- Explicit return types on all exported functions
- Structured logging via `@platform/logger` — never `console.log`
- Read env vars only from `@platform/config` — never `process.env` directly

See [CLAUDE.md](CLAUDE.md) for the full conventions reference.

---

## Getting help

- **For questions about a specific issue:** comment on the issue
- **For questions about architecture:** open a discussion issue or check the relevant ADR
- **For questions about the codebase:** check `/.claude/context/` for domain guides, or ask in a discussion

---

## Working with Claude Code (optional)

If you use [Claude Code](https://claude.com/claude-code) on this repo, the `.claude/` directory adds
a **delivery flow** (Plan → Code → Review → Ship) guided by best-effort hooks (guardrails, not a
security boundary — the real gate is CI, and PR review once branch protection requires it): you freeze and approve an
acceptance-criteria plan before editing source, review once at the end, and commit through a
procedure that runs the full exit condition. See [`.claude/README.md`](.claude/README.md).

**This is Claude-Code-only and does not change how you contribute.** The hooks fire only inside a
Claude Code session. Plain `git`, the Husky `pre-commit`/`commit-msg` hooks, and CI are untouched —
human PRs are gated by CI exactly as documented above. You never need Claude Code to contribute.

The **Contribution guardrails** CI workflow enforces the same intent for _everyone_ (not just Claude
Code users): source changes should ship with tests, new tables/routes need isolation tests, and
`modules/` stays TypeScript-free. For a genuinely exempt change, put `[skip-tests-check]` or
`[skip-isolation-check]` **exactly as written — lowercase, square brackets** — in the PR title
with a one-line reason; the check is a literal case-sensitive match. Note also that the workflow
triggers on PR open/push/reopen, not on a title edit alone — if you add the token to an
already-open PR, push a commit or close/reopen the PR to get a fresh check run.

---

## Contribution Terms

**⚠️ Draft terms — not yet reviewed by a lawyer.** These are the default terms that apply to
anyone submitting a pull request, unless you've signed [`CLA.md`](CLA.md) directly (the two cover
the same ground — the PR template lets you check either box).

By submitting a pull request (or other contribution) to this repository, you confirm:

1. **The contribution is your own original work**, or you have sufficient rights to submit it, and
   you've disclosed in the PR description if it includes or is based on someone else's work.
2. **You irrevocably assign to Abhinav Mishra all copyright and patent rights in your
   contribution**, in exchange for a license back to you to keep using your own contribution
   however you like. This is an assignment of ownership, not just a license — see
   [`CLA.md`](CLA.md) for the full terms.
3. **If your employer has rights to intellectual property you create**, you confirm you have
   permission to contribute on this basis, or your employer has waived that right for this
   Project. If this applies to you, say so before contributing — a separate agreement covering
   your employer may be needed.

This is intentionally the lightweight, click-through version of [`CLA.md`](CLA.md) at the repo
root, which has the full legal text (patent assignment, representations, disclaimer) if you want
to read the complete terms or sign a standalone copy.

## License

OpenWind is released under the [GNU Affero General Public License v3.0](LICENSE). The assignment
in "Contribution Terms" above is what lets the project also be offered under a separate commercial
license to customers who don't want AGPL's obligations.
