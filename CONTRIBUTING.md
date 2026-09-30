# Contributing to OpenWind

Thank you for your interest in contributing. OpenWind is currently in **Phase 3 (Scale & Extensibility)**, with active tracks across connector runtimes, plugin systems, AI layers, observability/compliance, on-call routing, temporal scheduling, reporting dashboards, and cross-functional workflow visibility.

Per-track live status changes frequently — check [`docs/tracker/roadmap-tracker.md`](docs/tracker/roadmap-tracker.md) for current truth.

---

## Before you start

1. **Read [`CLAUDE.md`](CLAUDE.md)** — Core engineering conventions enforced by CI (naming, TypeScript strictness, security rules, and testing requirements).
2. **Review the [Architecture Decision Records (ADRs)](docs/decisions/)** for your area of work. ADRs document settled technical decisions to prevent re-litigating them in PRs.
3. **Check the [Roadmap Tracker](docs/tracker/roadmap-tracker.md)** to see active vs. unstarted tracks.
4. **Know the [Contribution Terms](#contribution-terms)** — Submitting a PR requires agreeing to the terms (or signing [`CLA.md`](CLA.md)).

---

## What to work on

### Finding open work

1. **Active tracks:** Check [`docs/tracker/roadmap-tracker.md`](docs/tracker/roadmap-tracker.md) for open track issues.
2. **Track-labeled issues:** Browse [open issues](https://github.com/TinyPhi/OpenWind/issues) filtered by `phase-3` or track prefixes (`[3A]`, `[3C]`, `[3E]`, `[3F]`, `[3G]`, `[3H]`).
3. **Good first issues:** Issues tagged [`good first issue`](https://github.com/TinyPhi/OpenWind/issues?q=is%3Aopen+label%3A%22good+first+issue%22) are scoped to be completable without deep engine knowledge.

### Claiming and assigning issues

To keep work coordinated and prevent duplicate effort, open issues must be claimed before starting:

- **Self-assign (Contributors):** Comment `/take`, `/assign`, or `.take` on an issue labelled [`good first issue`](https://github.com/TinyPhi/OpenWind/issues?q=is%3Aopen+label%3A%22good+first+issue%22) or [`help wanted`](https://github.com/TinyPhi/OpenWind/issues?q=is%3Aopen+label%3A%22help+wanted%22). The bot assigns it to you and reacts with 🚀. For any other issue, ask a maintainer to assign it.
- **Unassign:** If your availability changes, comment `/unassign`, `/drop`, or `.drop` to release the issue for others.
- **Command format:** Put the command at the start of its own line. Commands inside quotes (`>`) or code blocks, or in the middle of a sentence, are ignored.
- **Assigning others (Maintainers & In-house devs):** Maintainers (`OWNER`, `MEMBER`, `COLLABORATOR`) can assign or unassign team members directly by commenting `/assign @username` or `/unassign @username`.
  - _GitHub permission note:_ On a public repository, non-collaborators can only be assigned after they have commented on that specific issue.
- **Collision prevention:** If an issue is already assigned to another contributor, the bot blocks new claims. Please coordinate in the issue comments if you would like to collaborate.

### Proposing new work

For significant changes — new engine capabilities, new module types, or changes to existing ADRs — open a discussion issue before writing code. Cover the problem, why current designs do not solve it, and your proposed approach.

---

## Local setup

### Prerequisites

- Node.js 22+
- pnpm 11+ (`packageManager` in `package.json` pins the exact version)
- Docker (OrbStack recommended on macOS, or Docker Compose)

### First-time setup

The fastest path is the one-command bootstrap from the root [`README.md`](README.md):

```bash
pnpm install --frozen-lockfile && pnpm bootstrap
```

Manual step-by-step setup:

```bash
git clone https://github.com/TinyPhi/OpenWind.git
cd OpenWind

cp .env.example .env.local
docker compose up -d
# Profile options:
# --profile notifications (Novu email/in-app)
# --profile observability (Prometheus/Grafana/Alertmanager)
# --profile reporting (Superset dashboards)

pnpm install
pnpm db:migrate
pnpm db:seed
```

| Service         | URL                        | Default credentials               |
| --------------- | -------------------------- | --------------------------------- |
| Admin UI        | http://localhost:3001      | Zitadel login                     |
| API + docs      | http://localhost:3000/docs | —                                 |
| Zitadel console | http://localhost:8080      | admin@platform.local / Admin1234! |
| OpenBao UI      | http://localhost:8200      | Token: `dev-root-token`           |

### Running tests

```bash
pnpm test            # all unit tests
pnpm test:isolation  # RLS tenant isolation tests (mandatory if touching db/)
pnpm test:e2e        # full API end-to-end tests
pnpm typecheck       # TypeScript strict check across all packages
pnpm lint            # ESLint
```

Isolation tests are mandatory before submitting PRs that touch database tables or API routes to guard against tenant leakage.

---

## Architecture & Conventions

### The config-first rule (ADR-004)

**Modules are configuration, not code.** The three shared engines (Entity, Workflow, Automation) are written once. A business module is a seed SQL file inserting rows into `entity_types`, `entity_fields`, `workflow_states`, `workflow_transitions`, and `automation_rules`. It contains no backend TypeScript.

Before writing module code:

- Express behavior as database rows in existing engine tables where possible.
- If the engines cannot express a capability, propose an **engine PR** (new trigger type, action type, or field type) accompanied by tests and an ADR.
- Full details: [ADR-004 — Config-First Module Design](docs/decisions/ADR-004-config-first-module-design.md).

### Architecture Decision Records (ADRs)

Key architectural decisions are documented in [`docs/decisions/`](docs/decisions/).

- Check existing ADRs before introducing architectural changes.
- If proposing a change that contradicts an ADR, open a discussion first — ADRs can be superseded by agreement, not bypassed.
- If introducing a major architectural pattern, draft a new ADR covering context, decision, and consequences.

### Dependency rules

Dependencies flow strictly downward (enforced by ESLint and CI):

```
apps/*             → packages/*
modules/*          → packages/*   (never modules/* → modules/*)
entity-engine      → db only
workflow-engine    → db, entity-engine
automation-engine  → db, workflow-engine, entity-engine, teams, audit
teams              → db only
scheduler          → db, teams, config, logger
```

To see what depends on a file, run `pnpm dep:impact -- '<path-regex>'`.

Cross-module communication occurs only through the event bus (`packages/automation-engine`), the entity relation API, or tRPC procedures in `apps/api`.

### Security rules

- **Mandatory RLS:** Every table storing tenant data must have Postgres Row Level Security enabled and policies defined.
- **Strict Input Validation:** All external input (API payloads, webhooks, connector data) must be validated with Zod.
- **Parameterized Queries:** Use Drizzle parameterized queries only; never interpolate user strings into SQL.
- **No Secrets in Code:** Use `@platform/config` and secrets managers — never commit secrets or credentials.
- **Tenant-Scoped File Access:** Files reside on local disk (`packages/files`) with async ClamAV scanning, scoped per tenant.
- **Rate Limiting:** Public endpoints must be rate-limited per tenant (ADR-013).

To report a security vulnerability, email [security@tinyphi.com](mailto:security@tinyphi.com).

### Code style

- Strict TypeScript mode across the codebase.
- No `any` — use `unknown` and narrow with type guards or Zod schemas.
- Types derived from Zod schemas via `z.infer<>`.
- Structured logging via `@platform/logger` (no raw `console.log`).
- Read environment variables only via `@platform/config` (never `process.env` directly).
- Full guide: [`.claude/rules/code-style.md`](.claude/rules/code-style.md).

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

### Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(workflow-engine): cancel the sla timer on terminal transitions
fix(entity-engine): invalidate schema cache on field delete
chore(deps): upgrade hono to 4.x
test(db): add tenant isolation tests for workflow_events
docs(docs): document issue assignment and self-assign commands
```

Scope must be one of the areas listed in [`commitlint.config.ts`](commitlint.config.ts) (`workflow-engine`, `entity-engine`, `db`, `api`, `admin-ui`, `ci`, `docs`, etc.); commitlint rejects anything else. Subjects must be lower-case.

### Opening a PR & CI Guardrails

1. Open a draft PR early so reviewers can see direction.
2. Fill out the [PR template](.github/pull_request_template.md) completely.
3. Link the issue with `Closes #N`.
4. **Contribution Guardrails:** CI (`scripts/check-contribution-guardrails.sh`) requires that:
   - Source changes ship with tests.
   - New database tables or routes ship with isolation tests.
   - `modules/` remains configuration-only (no TypeScript logic).

#### PR Title Escape Tokens

For genuinely test-exempt changes (docs-only, pure refactors, comment updates), waive the check by adding an exact token to the **PR title**:

- `[skip-tests-check]`
- `[skip-isolation-check]`

_Note:_ Write the token in exact lowercase inside square brackets. Because CI triggers on `pull_request: [opened, synchronize, reopened]`, updating an open PR's title requires pushing a commit or closing and reopening the PR to re-run the check.

---

## Working with Claude Code (optional)

If you use [Claude Code](https://claude.com/claude-code), the `.claude/` directory provides workflow hooks (plan freeze, review gates, automated test feedback). See [`.claude/README.md`](.claude/README.md). These are optional local developer tools; standard git and CI enforce the same contribution standards for everyone.

---

## Getting help

- **Specific issues:** Comment directly on the GitHub issue.
- **Architecture questions:** Open a discussion or refer to relevant ADRs in [`docs/decisions/`](docs/decisions/).
- **Platform context:** Check `/.claude/context/` for primers and domain guides.

---

## Contribution Terms

By submitting a pull request to this repository, you confirm:

1. **Original Work:** Your contribution is your own original work or you have sufficient rights to submit it (disclosing any third-party origins in the PR description).
2. **Copyright & Patent Assignment:** You irrevocably assign copyright and patent rights in your contribution to Abhinav Mishra, in exchange for a license back to continue using your contribution. See [`CLA.md`](CLA.md) for full legal terms.
3. **Employer Rights:** If your employer holds rights to intellectual property you create, you confirm you have permission to contribute under these terms.

The CLA Assistant bot will prompt first-time contributors to confirm acceptance via comment on their initial PR.

## License

OpenWind is released under the [GNU Affero General Public License v3.0](LICENSE).
