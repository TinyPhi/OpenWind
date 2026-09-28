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

## Delivery flow (every change)

Plan → Code → Review → Docs → Ship. Hooks, state files, bypass envs and their limits are documented
once, in `.claude/README.md`; the completion contract is `.claude/references/definition-of-done.md`.
The hooks are guardrails, not a security boundary — CI + human PR review are the real gate.

1. `/spec` — write the spec (ADR, engine touched, data flow). Skip for small fixes with an issue.
2. `/spec-tasks` (or the `openwind-loop` pick step) — freeze the plan-lock; **human types
   `approve-plan`** — _Plan gate_
3. Implement with tests in the same pass; all edits first, no mid-review — _Code gate:
   `edit-gate` blocks `apps/`·`packages/`·`modules/` source edits without an approved plan-lock_
4. `/review` (+ `/security-review` for auth/tables/routes/files/secrets) → `write-review.sh` —
   _Review gate: needs plan + code + tests_
5. Add a dated file under `docs/tracker/week-log/`, update your track's own row in
   `roadmap-tracker.md` and any other doc the change touches → `write-docs-marker.sh --touched`,
   or `--skip "<reason>"` if the diff genuinely has no doc surface — _Docs gate_
6. Commit procedure (exit condition → marker → **human types `approve-ship`** → commit →
   push → PR) — never a bare commit — _Ship gate: `commit-gate` needs marker + review +
   docs marker all matching the diff_
7. `/ultrareview` before merge on non-trivial PRs

**Scale review effort to diff size and risk.** Full `/review` fan-out is for large or
security-sensitive diffs (new tables/routes/auth paths, multi-file features). For a small,
mechanical, config- or docs-only change, pass a low-effort hint in the skill's `args`. One review
pass per meaningfully-changed diff — don't re-run it once clean. (Unscaled reviews have already
hit the org's spend limit once.)

**Standing trust (owner-set only):** `OPENWIND_PLAN_AUTOPASS=1` removes the `approve-plan`
keypress and `OPENWIND_AUTOPASS=1` removes `approve-ship` — the plan-lock, review, docs marker and
ship marker are all still required, so neither is logged as a bypass. `OPENWIND_GATE=off` /
`SHIP_BYPASS=1` skip the artifact itself and are logged to `.claude/state/bypass.log`.

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

- Enable or implement parallel approval — off-limits regardless of phase (#65)
- Modify any `.github/workflows/` file (CI/CD — secret-exfiltration / check-disabling risk)
- Write or modify ADR files in `docs/decisions/`
- Force-push or rebase published commits
- Touch schema cache or `redis.keys()` code

---

## Available skills

| Skill                          | When to use                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `/spec`                        | Before any new feature                                                                  |
| `/spec-tasks`                  | Turn a spec into an ordered task list                                                   |
| `/spec-review`                 | Stress-test a spec before implementation                                                |
| `/security-review`             | Any PR touching auth, new tables, routes, file access, secrets                          |
| `/review`                      | Standard PR review                                                                      |
| `/verify`                      | After implementation — confirm the feature works end-to-end                             |
| `/simplify`                    | Post-implementation code quality pass                                                   |
| `/openwind-loop`               | Project-specific loop: exact commands, config-first test, exit condition                |
| `doubt-driven-development`     | Adversarial review of a non-trivial decision before it stands                           |
| `debugging-and-error-recovery` | Systematic root-cause debugging when a failure isn't obvious                            |
| `source-driven-development`    | Implementation grounded in official versioned docs (Phase 3 integrations)               |
| `interview-me`                 | Extract what the user actually wants before speccing or building                        |
| `idea-refine`                  | Transform a vague idea into a sharp direction with explicit trade-offs                  |
| `api-and-interface-design`     | New/changed route, tRPC procedure, or module contract; ADR-010 API shape                |
| `deprecation-and-migration`    | api_keys rotation/scopes-format migration (OQ-2/OQ-3), breaking schema/contract changes |

`/ultrareview` is a built-in Claude Code workflow (not a skill) — type it in any session.
It launches a parallel multi-agent review across correctness, security, and performance dimensions.
Run on all non-trivial PRs before merge.

---

## Failure modes to avoid

These are the most common ways agent output degrades — watch for them in your own work:

- **Wrong assumptions** — filling in ambiguous requirements without surfacing them.
  Use `interview-me` or write the assumption to BLOCKERS.md before proceeding.
- **Not managing confusion** — pressing forward when something doesn't add up.
  Stop, name the confusion, present the trade-off, wait for guidance.
- **Modifying orthogonal code** — touching files outside the task's scope.
  The config-first test catches this for `modules/`; apply the same discipline everywhere.
- **Skipping verification** — marking a criterion done based on "it seems right".
  Evidence required: tests pass, typecheck clean, lint clean.
- **Overcomplicated implementation** — three similar lines is better than a premature abstraction.
  If you are adding an abstraction, name the concrete duplication it removes.
- **False confidence on framework patterns** — using training-data patterns for versioned APIs.
  Use `source-driven-development` when the correctness of a pattern depends on the package version.

---

## Engine context docs (`.claude/context/`)

Load when working in those packages — key invariants, gotchas, error codes:

- `entity-engine.md` — two-phase validation, soft-delete, schema cache, audit hooks
- `workflow-engine.md` — pessimistic lock, TRANSITION_LOCKED retry, SLA outbox, append-only events
- `automation-engine.md` — recursion cap, circuit breaker, SSRF guard (issue #2, closed —
  still run `/security-review` on any PR touching it)

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

- pnpm typecheck: PASS / FAIL / N/A — docs-only
- pnpm lint: PASS / FAIL / N/A — docs-only
- pnpm test: PASS / FAIL / N/A — docs-only
- pnpm test:isolation: PASS / FAIL / N/A — docs-only

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
