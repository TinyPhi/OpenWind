# Skill: openwind-loop

Project-specific loop skill for the OpenWind platform.
Encodes the exact verification commands, config-first test, and autonomy rules for this codebase.

---

## When to use

Use this skill when handed a task from [first-loop-task.md](../../../docs/sup-docs/first-loop-task.md) or
when the Current Focus section of [CLAUDE.md](../../../CLAUDE.md) describes a track to implement.

---

## Loop procedure (two-pass: Writer → Verifier)

Each iteration is two separate Claude Code invocations with no shared context.

### Pass 1 — Writer

```
1. Read CLAUDE.md Current Focus section
2. Read VISION.md current milestone
3. Read PROGRESS.md if it exists (last iteration context; absent on first run)
4. Read BLOCKERS.md if it exists (open blockers; absent on first run)
5. git status + git log --oneline -5
6. Pick the first unchecked acceptance criterion
7. Do one unit of work (one migration, one package feature, one test suite)
8. Write what was done and what is next to PROGRESS.md
9. Stop — do not run verification commands
```

### Pass 2 — Verifier

```
1. Read PROGRESS.md
2. Run ALL hard gate commands independently (do not trust the writer's description)
3. Output exactly one of: LOOP_DONE | LOOP_FAIL | LOOP_BLOCKED (with reason)
```

---

## Verifier rules

- Output **LOOP_DONE** only if ALL hard gate commands pass AND every acceptance
  criterion in CLAUDE.md Current Focus is checked
- Output **LOOP_FAIL** if the commands ran but failed — writer gets another iteration
- Output **LOOP_BLOCKED** if the verifier cannot run checks (missing command, missing
  env var, Docker stack not up, etc.) — include the exact blocker
- The verifier may not pass based on the writer's description alone — it must
  run the commands itself

---

## Verification commands (run after every unit of work)

```bash
# Minimum — run after every commit
pnpm typecheck
pnpm lint

# After any package logic change
pnpm test

# After any migration or new table/route
pnpm test:isolation

# Full CI equivalent (requires Docker stack)
docker compose up -d
pnpm test:e2e
```

All four must be green before marking an acceptance criterion complete.

---

## Parallel worktrees

If more than one agent is running against this codebase simultaneously, each needs its
own git worktree to avoid conflicting writes:

```bash
git worktree add ../agent-[name]-branch [branch]
```

Each agent reads and writes only its own worktree. All agents write status back to
PROGRESS.md in the main worktree so the verifier has a unified view.

---

## Config-first test (run mentally before every commit)

> Did this require TypeScript changes outside `packages/*` or `apps/*`?

If **yes** — stop. Module-level logic belongs in the engine as a configurable capability.
Write the question to BLOCKERS.md and wait for guidance.

If **no** — proceed.

---

## Exit condition

The loop exits when every checkbox in the Current Focus acceptance criteria is checked
AND `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation` all pass.

Update `docs/sup-docs/roadmap-tracker.md` and `docs/sup-docs/week-log.md` at the end of each completed track.

---

## What to avoid

- Never write TypeScript inside `modules/` — modules are seed SQL only
- Never touch issue #2 (SSRF/PII), parallel approval code, or ADR files
- Never skip the isolation test suite when adding a new table or route
- Never use `any` — use `unknown` + Zod
- Never read `process.env` directly — import from `@platform/config`
- Never open a new DB connection — import from `@platform/db`

---

## Commit message format

```
feat(db): add module_registry table and seed runner
feat(modules): helpdesk seed — ticket workflow + SLA automation
test(isolation): add RLS tests for module-seeded entity types
fix(seed-runner): handle duplicate module install gracefully
```

Conventional Commits format. Scope = the package or track name.
