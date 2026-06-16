# Agent Behaviour — OpenWind Platform

Autonomy level: **2** — Make reasonable implementation calls; surface decisions that affect
architecture, security, or the DB/API contract.

---

## Session startup

At the start of every session:

1. Read CLAUDE.md Current Focus section
2. Read PROGRESS.md if it exists (prior iteration context)
3. Check BLOCKERS.md if it exists — address anything open before new work
4. `git status && git log --oneline -5`

---

## Loop procedure

1. **Read state** — PROGRESS.md, CLAUDE.md Current Focus, git log
2. **Pick** the first unchecked acceptance criterion
3. **Implement** — one logical unit (one migration, one package feature, one test suite)
4. **Verify** — run exit condition; fix before moving on
5. **Commit** — one unit of work per commit
6. **Write PROGRESS.md** — what was done, what's next, any open questions
7. **Repeat** from step 2

---

## Exit condition

All four must be green before marking a criterion complete:

```bash
pnpm typecheck          # zero type errors
pnpm lint               # zero lint errors (--max-warnings=0)
pnpm test               # unit + integration tests pass
pnpm test:isolation     # RLS isolation tests pass
```

Full CI run (requires Docker/OrbStack):

```bash
docker compose up -d && pnpm test:e2e
```

---

## Autonomy rules

**Proceed without asking:**

- Implementing clearly specified acceptance criteria
- Adding tests alongside new code (always same pass)
- Fixing lint/type errors you introduced
- Writing migrations that follow the established pattern
- Choosing between equivalent implementation approaches

**Stop and write to BLOCKERS.md (create if absent):**

- A decision changes the schema or API contract of an existing package
- An acceptance criterion is ambiguous — state your assumption and ask
- A test you didn't write is failing and the cause isn't clear after 2 attempts
- The config-first test fails — you're about to write TypeScript in `modules/`

**Never do autonomously:**

- Touch issue #2 (SSRF/PII gaps) — human review required
- Enable or implement parallel approval — deferred to Phase 3
- Modify `.github/workflows/ci.yml`
- Write or modify ADR files in `docs/decisions/`
- Force-push or rebase published commits
- Touch schema cache or `redis.keys()` code

---

## Session workflow (every feature track)

1. `/spec` — write spec referencing the ADR, engine it touches, and data flow
2. `/spec-tasks` — turn spec into ordered task list
3. Implement with tests in same pass — never implementation without tests
4. `gh pr create` → `/ultrareview` before merge
5. For PRs touching auth, new tables, new routes, or files: also run `/security-review`
6. Update `docs/sup-docs/week-log.md` and `docs/sup-docs/roadmap-tracker.md`

---

## Available skills

| Skill              | When to use                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `/spec`            | Before any new feature                                                   |
| `/spec-tasks`      | Turn a spec into an ordered task list                                    |
| `/spec-review`     | Stress-test a spec before implementation                                 |
| `/security-review` | Any PR touching auth, new tables, routes, file access, secrets           |
| `/review`          | Standard PR review                                                       |
| `/verify`          | After implementation — confirm the feature works end-to-end              |
| `/simplify`        | Post-implementation code quality pass                                    |
| `/openwind-loop`   | Project-specific loop: exact commands, config-first test, exit condition |

`/ultrareview` is a built-in Claude Code workflow (not a skill) — type it in any session.
It launches a parallel multi-agent review across correctness, security, and performance dimensions.
Run on all non-trivial PRs before merge.

---

## Engine context docs (`.claude/context/`)

Load when working in those packages — key invariants, gotchas, error codes:

- `entity-engine.md` — two-phase validation, soft-delete, schema cache, audit hooks
- `workflow-engine.md` — pessimistic lock, TRANSITION_LOCKED retry, SLA outbox, append-only events
- `automation-engine.md` — recursion cap, circuit breaker, SSRF guard, issue #2 warning

---

## Prompt templates (`.claude/prompts/`)

- `new-module.md` — seed SQL scaffold for a new business module
- `new-migration.md` — migration with RLS, indexes, analytics annotation, rollback
- `new-route.md` — Hono route with Zod validation and tests
- `new-workflow-config.md` — workflow states + transitions + SLA as seed SQL
- `new-connector.md` — third-party connector scaffold (Phase 3)

---

## Humans stay in the loop for

- Writing or modifying ADRs
- Security-sensitive code paths — always `/security-review`
- Phase exit decisions — no phase advance without explicit sign-off
- Pilot customer interactions

---

## PROGRESS.md format

```markdown
## [date] — [track/task]

### Done

- [what was implemented and committed]

### Verification

- pnpm typecheck: PASS / FAIL
- pnpm lint: PASS / FAIL
- pnpm test: PASS / FAIL
- pnpm test:isolation: PASS / FAIL

### Next

- [next unchecked acceptance criterion]

### Open questions

- [decisions surfaced, if any]
```

---

## BLOCKERS.md format

```markdown
## Blocker: [title]

**Date:** [today]
**What I was doing:** [one sentence]
**What's blocking:** [specific question or missing info]
**What I tried:** [list]
**Options:** [if any]
```
