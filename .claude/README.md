# `.claude/` — Agent guardrails for OpenWind

This directory configures **Claude Code** for this repo: rules, context docs, prompt scaffolds,
skills, and a set of **hooks that enforce a gated delivery flow**. The hooks are the *teeth*; the
skills produce the artifacts the hooks check.

> **Not using Claude Code? This does not affect you.** Every hook here fires *only* inside a Claude
> Code session. Plain `git`, the Husky `pre-commit`/`commit-msg` hooks, and GitHub Actions CI are
> untouched. Human PRs are gated by CI exactly as before. Nothing in this directory can block a
> contributor who does not run Claude Code.

## The gated delivery flow

Work moves through four stages; each is independently runnable and pausable, and **each is gated on
the previous stage's artifact** (hard block, every session):

```
 PLAN ─────────► CODE ─────────► REVIEW ─────────► SHIP
 freeze+approve   all edits +     one /review at    typecheck+lint+test+
 acceptance       tests first     the end (+        test:isolation, marker,
 criteria         (no mid-review) /security-review) commit, structured PR
      │                │                │                  │
  plan.json       EDIT GATE        REVIEW GATE        COMMIT GATE
  (approved)      needs approved   needs plan+code+   needs review.json
                  plan.json        tests → review.json (matching diff) + marker
```

The discipline lives **inside the existing skills** — `/spec-tasks` (or the `openwind-loop` pick
step) freezes the plan, `/review` + `/security-review` produce the review, the loop's commit
procedure ships. No new skill to learn.

### Two human checkpoints

1. **Approve the freeze** (start) — `plan.json` is invalid until you approve it (`approved:true`).
   This is where you should spend the most time. Hedged answers ("looks fine") are *not* approval.
2. **Approve the pass** (end) — the commit step waits for your OK before committing
   (`OPENWIND_AUTOPASS=off`). Set `OPENWIND_AUTOPASS=on` once you trust the flow.

## Hooks

| Hook | Event / matcher | What it does | Block? | Bypass (logged) |
| --- | --- | --- | --- | --- |
| `edit-gate.sh` | PreToolUse `Write\|Edit` | no edits to `apps/`·`packages/`·`modules/` without an **approved** `plan.json` | hard | `OPENWIND_GATE=off` |
| `commit-gate.sh` | PreToolUse `Bash` | no `git commit` without a fresh marker **and** a review matching the diff | hard | `SHIP_BYPASS=1` |
| `ship-cleanup.sh` | PostToolUse `Bash` | deletes the marker + done-sentinel after a commit (one-shot) | — | — |
| `destructive-guard.sh` | PreToolUse `Bash` | blocks `rm -rf` on risky paths, `DROP`/`TRUNCATE`, `--no-verify`, `push --force` | hard | none |
| `protected-paths.sh` | PreToolUse `Write\|Edit` | blocks edits on `main`/`develop`, `modules/*.ts`, ADRs, `ci.yml`, `.env*` | hard | `OPENWIND_OFFLIMITS=ack`, `OPENWIND_ALLOW_MODULE_TS=1` |
| `verify-stop.sh` | Stop | only when a `claimed-done` sentinel exists: blocks a *false* "done" if the pipeline did not finish (cheap check; does **not** re-run typecheck) | conditional | clear the sentinel |
| `session-start.sh` | SessionStart | injects the rules into context each session | — | — |
| `write-plan.sh` | helper | writes/approves `plan.json` (called by the Plan stage) | — | — |
| `write-review.sh` | helper | writes `review.json` after `/review` (enforces plan+diff+tests) | — | — |
| `write-ship-marker.sh` | helper | writes `ship-ready.json` right before commit | — | — |

The two **existing** hooks are preserved: a PostToolUse ESLint pass on edited `.ts` files, and a
new-migration reminder.

## State (`.claude/state/`, gitignored)

Per-branch / per-session, never committed: `plan.json`, `review.json`, `ship-ready.json`,
`claimed-done`, `bypass.log`. Because `plan.json` is gitignored, the commit step copies its
acceptance criteria into the **PR body** so human reviewers see the frozen contract.

`PROGRESS.md` / `BLOCKERS.md` (written by the loop) are gitignored too.

## Bypasses

Every bypass env is honored and **logged to `.claude/state/bypass.log`** with timestamp + branch.
They exist for genuine cases (bootstrapping this system, hotfixes, human-directed ADR edits) — not
routine use. See `references/definition-of-done.md` for the completion contract the gates enforce.
