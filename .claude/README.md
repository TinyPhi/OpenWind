# `.claude/` — Agent guardrails for OpenWind

This directory configures **Claude Code** for this repo: rules, context docs, prompt scaffolds,
skills, and a set of **hooks that guide a disciplined delivery flow** (Plan → Code → Review → Ship).

> ### These are guardrails, not barricades
>
> The hooks make the disciplined path the easy default and catch **honest mistakes** early — fast
> local feedback before CI. They are **not a security boundary.** A determined agent can bypass them
> (write its own state files directly, write files via `Bash` instead of the Write tool, or run a
> wrapper script the per-command hooks don't see). They are deliberately best-effort.
>
> **The real enforcement lives outside these scripts — and most of it must be enabled in GitHub
> settings, not here:** **CI** is active today and runs on every PR (the only currently-binding gate).
> **Branch protection + required PR review** are what make the human approval un-fakeable, and a
> `.github/CODEOWNERS` (for `.claude/` · `scripts/` · `.github/`) is included — but CODEOWNERS only
> has teeth once a branch-protection rule requires code-owner review, which is **not yet configured.**
> Until then, treat the hooks as a seatbelt, not a vault, and CI as the floor.

> **Not using Claude Code? This does not affect you.** Every hook here fires _only_ inside a Claude
> Code session. Plain `git`, the Husky `pre-commit`/`commit-msg` hooks, and GitHub Actions CI are
> untouched. Human PRs are gated by CI exactly as before. Nothing in this directory can block a
> contributor who does not run Claude Code.

## The delivery flow

Work moves through five stages; each is independently runnable and pausable. Each **nudges** you to
produce the previous stage's artifact before the next — a speed bump that makes the disciplined path
the default, not a hard wall (see "guardrails, not barricades" above):

```
 PLAN ─────────► CODE ─────────► REVIEW ─────────► DOCS ─────────► SHIP
 freeze+approve   all edits +     one /review at    docs/** or an   typecheck+lint+test+
 acceptance       tests first     the end (+        explicit skip   test:isolation, marker,
 criteria         (no mid-review) /security-review) reason          commit, structured PR
      │                │                │                │                │
  plan.json       EDIT GATE        REVIEW GATE      (checked at      COMMIT GATE
  (approved)      needs approved   needs plan+code+  commit time)    needs review.json +
                  plan.json        tests → review.json               docs-updated.json (both
                                                                       matching diff) + marker
```

The discipline lives **inside the existing skills** — `/spec-tasks` (or the `openwind-loop` pick
step) freezes the plan, `/review` + `/security-review` produce the review, `write-docs-marker.sh`
confirms docs kept pace, the loop's commit procedure ships. No new skill to learn.

### Docs stay in sync, commit by commit

Every commit either updates the relevant docs (`docs/**`, `CLAUDE.md`, `README.md`, or a
`.claude/**/*.md` rule/reference file) or explicitly records why this particular diff needs none —
there is no silent third option. Run `write-docs-marker.sh --touched` once doc changes are staged
alongside the code, or `write-docs-marker.sh --skip "<reason>"` for a change that genuinely has no
doc surface (e.g. a pure refactor with no behavior change). The commit gate checks the marker's
`diff_sha` against `git diff HEAD`, exactly like the review marker — editing anything afterward
invalidates it and it must be re-run.

### Two human checkpoints (a convention the hooks encourage)

The intent is that a human approves twice — `approve-plan` (unlock edits) and `approve-ship` (unlock
the commit) — via the `approval-gate` hook, which fires on _your_ chat message rather than agent
output. That makes **accidental** self-approval unlikely. It is **not** a hard guarantee: the approval
state is a plain file, so a determined agent can still write it. The approval that genuinely cannot be
faked is the **human review on the pull request** — _once branch protection requires it_. Keep that
as the real gate. `OPENWIND_AUTOPASS=1` skips the ship checkpoint.

1. **Approve the freeze** (start) — the agent drafts `plan.json`; you type `approve-plan` in chat to
   unlock source edits. The agent's `write-plan.sh approve` is refused (it must ask you).
2. **Approve the pass** (end) — after the checks pass, you type `approve-ship`; the commit gate
   stays blocked until that approval matches the exact diff being committed.

## Hooks

| Hook                   | Event / matcher          | What it does                                                                                                                                    | Block?      | Bypass (logged)                                        |
| ---------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
| `edit-gate.sh`         | PreToolUse `Write\|Edit` | no edits to `apps/`·`packages/`·`modules/` without an **approved** `plan.json`                                                                  | hard        | `OPENWIND_GATE=off`                                    |
| `commit-gate.sh`       | PreToolUse `Bash`        | no `git commit` without a fresh marker, a review matching the diff, a docs marker matching the diff, **and** the human `approve-ship`           | hard        | `SHIP_BYPASS=1`                                        |
| `ship-cleanup.sh`      | PostToolUse `Bash`       | deletes the marker + docs marker + done-sentinel after a commit (one-shot)                                                                      | —           | —                                                      |
| `destructive-guard.sh` | PreToolUse `Bash`        | blocks `rm -rf` on risky paths, `DROP`/`TRUNCATE TABLE`, `--no-verify`, `push --force`                                                          | default     | subshell/wrapper (like all hooks)                      |
| `protected-paths.sh`   | PreToolUse `Write\|Edit` | blocks edits on `main`/`develop`, `modules/*.ts`, ADRs, `.github/workflows/*`, `.env*`                                                          | hard        | `OPENWIND_OFFLIMITS=ack`, `OPENWIND_ALLOW_MODULE_TS=1` |
| `verify-stop.sh`       | Stop                     | only when a `claimed-done` sentinel exists: blocks a _false_ "done" if the pipeline did not finish (cheap check; does **not** re-run typecheck) | conditional | clear the sentinel                                     |
| `session-start.sh`     | SessionStart             | injects the rules into context each session                                                                                                     | —           | —                                                      |
| `write-plan.sh`        | helper                   | drafts `plan.json` (Plan stage); approval is human-only via `approve-plan`                                                                      | —           | —                                                      |
| `write-review.sh`      | helper                   | writes `review.json` after `/review` (enforces plan+diff+tests)                                                                                 | —           | —                                                      |
| `write-docs-marker.sh` | helper                   | writes `docs-updated.json` (Docs stage) — `--touched` records doc files in the diff, `--skip "<reason>"` justifies none                         | —           | —                                                      |
| `write-ship-marker.sh` | helper                   | writes `ship-ready.json` right before commit                                                                                                    | —           | —                                                      |

Plus `approval-gate.sh` (UserPromptSubmit) — the human-only approval path (`approve-plan` /
`approve-ship`) — and `mark-done.sh` — the helper the agent runs to assert completion (writes the
sentinel `verify-stop` checks). The two **existing** hooks are preserved as-is (a PostToolUse ESLint
pass and a new-migration reminder; left untouched, and not relied upon by this flow).

## State (`.claude/state/`, gitignored)

Keyed by branch, never committed: `plan/<branch-slug>.json`, `review/<branch-slug>.json`,
`docs-updated/<branch-slug>.json`, `ship-ready/<branch-slug>.json`, `pass-approved/<branch-slug>.json`,
`claimed-done/<branch-slug>` (plus a shared `bypass.log`). Because `plan/` is gitignored, the
commit step copies its acceptance criteria into the **PR body** so human reviewers see the frozen
contract.

Keying by branch means switching branches in the same working directory no longer clobbers
another branch's plan/review/ship state — each branch gets its own file. `.claude/hooks/lib/context.js`
centralizes the path logic (`statePath(repo, kind, branch)`) so every hook agrees on where a given
branch's state lives.

`PROGRESS.md` / `BLOCKERS.md` (written by the loop) are gitignored too.

## Bypasses

Every bypass env is honored and **logged to `.claude/state/bypass.log`** with timestamp + branch.
They exist for genuine cases (bootstrapping this system, hotfixes, human-directed ADR edits) — not
routine use. See `references/definition-of-done.md` for the completion contract the gates enforce.

**`bash run.sh` (subshell invoke):** commit-gate parses the Bash tool's command string — it cannot
inspect what a shell script calls. A script containing `git commit` bypasses commit-gate silently.
Mitigated by edit-gate (blocks edits without a plan), Husky pre-commit (still fires inside the
subshell's git process), and the SHIP_BYPASS audit log, but worth knowing.

## Known limitations

**Worktrees are supported, not just tolerated.** State is keyed by branch, and `edit-gate`,
`commit-gate`, `ship-cleanup`, `approval-gate`, and `verify-stop` all resolve the repo/worktree a
given tool call actually targets — from the file path for `Write`/`Edit`, from an explicit
`cd <dir> &&` / `git -C <dir>` in a `Bash` command, or (for the two hooks with no such anchor,
`approval-gate` and `verify-stop`) by scanning the main checkout plus every `git worktree` for the
one location with a matching pending item. This means running parallel branches across separate
worktrees from the same Claude Code session works correctly. If a scan finds **more than one**
matching pending plan/marker across locations, the hook reports the ambiguity (branch + path for
each) instead of guessing — say which branch you mean.

**State files are still not locked.** `.claude/state/` has no file locking. Two concurrent
sessions on the _same_ branch in the _same_ worktree share that branch's `plan/`, `review/`,
`ship-ready/`, and `pass-approved/` files. The failure modes are conservative (one session's stale
marker blocks the other) — use separate worktrees per concurrent branch (see git-conventions.md)
to avoid this entirely, which the fixes above now make load-bearing rather than best-effort.

**`pass-approved/<branch>.json` is not snapshotted by the marker.** The commit-gate checks
pass-approval at commit time, independently of when the marker was written. If that file is
cleared between marker-write and commit (e.g., `ship-cleanup.sh` fires on an unrelated failed
commit), the human needs to type `approve-ship` again. The conservative failure mode is correct —
this note is here so it doesn't surprise you.
