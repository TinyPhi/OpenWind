# Skill: openwind-loop

Project-specific loop skill for the OpenWind platform.
Encodes the exact verification commands, config-first test, and autonomy rules for this codebase.

---

## When to use

Use this skill when handed a task from [first-loop-task.md](../../../first-loop-task.md) or
when the Current Focus section of [CLAUDE.md](../../../CLAUDE.md) describes a track to implement.

---

## Loop entry

```
1. Read CLAUDE.md Current Focus section
2. Read VISION.md current milestone
3. Read PROGRESS.md (last iteration context)
4. Read BLOCKERS.md (any open blockers from previous runs)
5. git status + git log --oneline -5
6. Pick the first unchecked acceptance criterion
7. Implement → test → verify → commit → update PROGRESS.md
8. Repeat from step 6
```

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
