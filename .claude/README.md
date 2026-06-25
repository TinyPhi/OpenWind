# `.claude/` — Agent guardrails for OpenWind

This directory configures **Claude Code** for this repo: rules, context docs, prompt scaffolds,
skills, and a set of **hooks that enforce a gated delivery flow**. The hooks are the _teeth_; the
skills produce the artifacts the hooks check.

> **Not using Claude Code? This does not affect you.** Every hook here fires _only_ inside a Claude
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

### Two human checkpoints (real — the agent cannot self-approve)

Approval enters the system **only** through the `approval-gate` hook, which fires on _your prompt_ —
something the agent cannot emit (it produces tool calls + text, never a user message). So the agent
literally cannot approve its own work.

1. **Approve the freeze** (start) — the agent drafts `plan.json`; **you type `approve-plan`** in chat
   to unlock source edits. The agent's `write-plan.sh approve` is refused.
2. **Approve the pass** (end) — after the checks pass, **you type `approve-ship`**; the commit gate
   stays blocked until that approval matches the exact diff being committed. Set `OPENWIND_AUTOPASS=1`
   to graduate to auto (skips the pass checkpoint).

## Hooks

| Hook                   | Event / matcher          | What it does                                                                                                                                    | Block?      | Bypass (logged)                                        |
| ---------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| `edit-gate.sh`         | PreToolUse `Write\|Edit` | no edits to `apps/`·`packages/`·`modules/` without an **approved** `plan.json`                                                                  | hard        | `OPENWIND_GATE=off`                                    |
| `commit-gate.sh`       | PreToolUse `Bash`        | no `git commit` without a fresh marker, a review matching the diff, **and** the human `approve-ship`                                            | hard        | `SHIP_BYPASS=1`                                        |
| `ship-cleanup.sh`      | PostToolUse `Bash`       | deletes the marker + done-sentinel after a commit (one-shot)                                                                                    | —           | —                                                      |
| `destructive-guard.sh` | PreToolUse `Bash`        | blocks `rm -rf` on risky paths, `DROP`/`TRUNCATE`, `--no-verify`, `push --force`                                                                | hard        | none                                                   |
| `protected-paths.sh`   | PreToolUse `Write\|Edit` | blocks edits on `main`/`develop`, `modules/*.ts`, ADRs, `.github/workflows/*`, `.env*`                                                          | hard        | `OPENWIND_OFFLIMITS=ack`, `OPENWIND_ALLOW_MODULE_TS=1` |
| `verify-stop.sh`       | Stop                     | only when a `claimed-done` sentinel exists: blocks a _false_ "done" if the pipeline did not finish (cheap check; does **not** re-run typecheck) | conditional | clear the sentinel                                     |
| `session-start.sh`     | SessionStart             | injects the rules into context each session                                                                                                     | —           | —                                                      |
| `write-plan.sh`        | helper                   | drafts `plan.json` (Plan stage); approval is human-only via `approve-plan`                                                                      | —           | —                                                      |
| `write-review.sh`      | helper                   | writes `review.json` after `/review` (enforces plan+diff+tests)                                                                                 | —           | —                                                      |
| `write-ship-marker.sh` | helper                   | writes `ship-ready.json` right before commit                                                                                                    | —           | —                                                      |

Plus `approval-gate.sh` (UserPromptSubmit) — the human-only approval path (`approve-plan` /
`approve-ship`) — and `mark-done.sh` — the helper the agent runs to assert completion (writes the
sentinel `verify-stop` checks). The two **existing** hooks are preserved: a PostToolUse ESLint pass
on edited `.ts` files, and a new-migration reminder.

## State (`.claude/state/`, gitignored)

Per-branch / per-session, never committed: `plan.json`, `review.json`, `ship-ready.json`,
`claimed-done`, `bypass.log`. Because `plan.json` is gitignored, the commit step copies its
acceptance criteria into the **PR body** so human reviewers see the frozen contract.

`PROGRESS.md` / `BLOCKERS.md` (written by the loop) are gitignored too.

## Bypasses

Every bypass env is honored and **logged to `.claude/state/bypass.log`** with timestamp + branch.
They exist for genuine cases (bootstrapping this system, hotfixes, human-directed ADR edits) — not
routine use. See `references/definition-of-done.md` for the completion contract the gates enforce.
