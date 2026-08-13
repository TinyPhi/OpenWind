---
name: openwind-loop
description: Project-specific autonomous delivery loop for OpenWind. Encodes the exact verification commands, config-first test, and autonomy rules for taking a CLAUDE.md Current Focus track (or an explicit feature spec) through Plan-lock, implementation, and the gated commit procedure. Invoke when CLAUDE.md's Current Focus names a track to implement.
---

# Skill: openwind-loop

Project-specific loop skill for the OpenWind platform.
Encodes the exact verification commands, config-first test, and autonomy rules for this codebase.

---

## When to use

Use this skill when the Current Focus section of [CLAUDE.md](../../../CLAUDE.md) describes a
track to implement, or when handed an explicit task spec for a feature track.

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
6a. FREEZE THE PLAN-LOCK — if there is no approved plan-lock for this branch, build a payload from
    the chosen criterion (with a `verify` command + `scope_paths`), run
    `echo '<payload>' | .claude/hooks/write-plan.sh set -`, present the criteria to the human, and
    ask them to type `approve-plan` in chat (the agent must not self-approve). The edit gate guards
    source edits until the human has approved. (Same mechanism as /spec-tasks; see it for the payload.)
7. Do one unit of work (one migration, one package feature, one test suite) — all edits + tests first
8. Write what was done and what is next to PROGRESS.md
9. Stop — do not run verification commands; do NOT run `git commit` (use the commit procedure below)
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
- **Stop-hook backstop:** when the writer asserts a unit is complete in an autonomous run, it writes
  `.claude/state/claimed-done`. The Stop hook then blocks the session from ending if the pipeline
  did not actually finish (source still uncommitted). It does **not** re-run typecheck — the commit
  procedure already owns verification. Clear the sentinel to pause mid-work intentionally.

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

## Commit procedure (the SHIP stage — never raw `git commit`)

The commit gate blocks a bare `git commit` in the common path (best-effort; bypassable via a subshell
or `SHIP_BYPASS=1`). Once a unit is complete, run this procedure (it is
the canonical, gate-respecting way _any_ change — even a one-liner — gets committed; there is no new
skill to learn):

1. **All edits + tests are in.** No mid-review — review happens once, at the end.
2. Run the exit condition: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation`. Block on any red.
3. Run `/review` (and `/security-review` if the diff touches auth/db/routes/files/secrets). Triage
   findings; apply ACCEPTED. Check the diff against `.claude/references/definition-of-done.md`.
4. Record the review: `echo '<payload>' | .claude/hooks/write-review.sh -` (it refuses unless an
   approved plan-lock exists, the diff is non-empty, and tests are present). Payload carries
   `verdict`, `dod_met`, `dod_unmet`, `security_review`.
5. **Present the pass to the human; they type `approve-ship` in chat** to approve it — the agent
   must not self-approve. The commit gate stays blocked until that approval matches the diff. Required
   on every commit until the owner sets `OPENWIND_AUTOPASS=1`.
6. Stage explicitly (never `git add -A`). Add a new dated file under
   `docs/sup-docs/week-log/` (see its README — never edit `week-log.md`, it's frozen history)
   and update your track's own row in `roadmap-tracker.md`.
7. `.claude/hooks/write-ship-marker.sh` — **write the marker LAST**, after the exit condition and
   review have finished, so its 60-min window covers only stage→commit, not the (possibly slow)
   test run. Then `git commit` (Conventional Commits, lowercase subject). Use a **valid scope from
   the project's commitlint config** (e.g. `dx` for tooling) — `claude` is not allowed and CI will reject it.
8. Push, open a structured PR (paste the plan-lock acceptance criteria into the PR body).
9. **Monitor CI to green — this is part of raising the PR, not optional.** Poll the PR checks until
   terminal; if any job fails, read the failed log, fix on the same branch, and push again. The PR is
   not "raised" until CI is green. Never merge — that is the human's action.

| The excuse                     | The reality                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| "I'll review while I edit."    | Mid-review is wasted tokens on code that will change. Edits first, one review at the end. |
| "Tests pass, ship it."         | The pass is the human's call until `OPENWIND_AUTOPASS=on`. Present it.                    |
| "Bare `git commit` is faster." | The commit gate blocks it. Run the procedure; the marker is what unlocks the commit.      |
| "PR is open, I'm done."        | Raising a PR includes watching CI to green and fixing failures. Open + red ≠ done.        |

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

Update `docs/sup-docs/roadmap-tracker.md` (your track's own row) and add a closing entry under
`docs/sup-docs/week-log/` at the end of each completed track.

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
