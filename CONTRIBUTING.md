# Contributing to OpenWind

Thank you for your interest in contributing. OpenWind is in active early development — Phase 1 (the engine layer) is being built now. This is the highest-leverage time to contribute: decisions made here have a blast radius of 100%.

---

## Before you start

1. **Read [`CLAUDE.md`](CLAUDE.md)** — engineering conventions enforced by CI (naming, TypeScript strictness, security rules, testing requirements). Not optional reading.
2. **Read the relevant ADR(s)** in [`docs/decisions/`](docs/decisions/) for the area you're working in. The ADRs explain _why_ things are the way they are — they prevent you from re-litigating settled decisions in a PR.
3. **Check the [roadmap](docs/roadmap.md)** to understand which phase a component belongs to and what it depends on. Phase 2 components cannot be built without Phase 1 being solid.

---

## What to work on

### Phase 1 issues (open now)

The five Phase 1 component issues are the right place to start for new contributors. Each is self-contained, has clear scope, and links to the relevant ADRs:

| Issue                                                                            | Component                                        | Depends on |
| -------------------------------------------------------------------------------- | ------------------------------------------------ | ---------- |
| [#7 — 1A Infrastructure & tenancy](https://github.com/TinyPhi/OpenWind/issues/7) | Postgres migrations, RLS, OpenBao, rate limiting | Nothing    |
| [#8 — 1B Auth](https://github.com/TinyPhi/OpenWind/issues/8)                     | Zitadel JWT, RBAC, API keys                      | #7         |
| [#9 — 1C Entity Engine](https://github.com/TinyPhi/OpenWind/issues/9)            | Entity types, fields, runtime Zod, Redis cache   | #7, #8     |
| [#10 — 1D Workflow Engine](https://github.com/TinyPhi/OpenWind/issues/10)        | State machine, transitions, SLA timers           | #9         |
| [#11 — 1E Automation Engine](https://github.com/TinyPhi/OpenWind/issues/11)      | Outbox, rule executor, trigger/action types      | #9, #10    |

Each issue has a detailed scope table. Pick one, comment that you're working on it, and open a draft PR early.

### Good first issues

Issues tagged [`good first issue`](https://github.com/TinyPhi/OpenWind/issues?q=is%3Aopen+label%3A%22good+first+issue%22) are scoped to be completable without deep platform knowledge. They're a good way to get familiar with the codebase before tackling an engine component.

### Proposing new work

For significant contributions — new engine capabilities, new module types, changes to existing ADRs — open a discussion issue before writing code. The discussion should cover: what problem you're solving, why the current design doesn't solve it, and what you're proposing. This prevents wasted effort on approaches that conflict with existing decisions.

---

## Local setup

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker and Docker Compose

### First-time setup

```bash
git clone https://github.com/TinyPhi/OpenWind.git
cd OpenWind

cp .env.example .env.local
# Edit .env.local — defaults work for local dev, no changes needed unless noted

docker compose up -d
# Starts: Postgres, Redis, MinIO, Zitadel, Novu, MailHog, OpenBao

pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

| Service         | URL                        | Default credentials               |
| --------------- | -------------------------- | --------------------------------- |
| Admin UI        | http://localhost:3001      | Zitadel login                     |
| API + docs      | http://localhost:3000/docs | —                                 |
| Zitadel console | http://localhost:8080      | admin@platform.local / Admin1234! |
| MailHog         | http://localhost:8025      | —                                 |
| MinIO console   | http://localhost:9001      | minioadmin / minioadmin           |
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

| ADR                                                             | Decision                                         |
| --------------------------------------------------------------- | ------------------------------------------------ |
| [ADR-001](docs/decisions/ADR-001-multitenancy.md)               | Multi-tenancy via Postgres RLS                   |
| [ADR-002](docs/decisions/ADR-002-workflow-engine.md)            | DB-native workflow state machine                 |
| [ADR-003](docs/decisions/ADR-003-field-validation.md)           | Runtime Zod schema generation from entity fields |
| [ADR-004](docs/decisions/ADR-004-config-first-module-design.md) | Modules are config (seed SQL), not code          |

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
- **File access via presigned URLs only.** The S3 bucket is never publicly accessible.
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

## License

By contributing to OpenWind, you agree that your contributions will be licensed under the [GNU Affero General Public License v3.0](LICENSE).
