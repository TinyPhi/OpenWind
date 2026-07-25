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

Per-branch / per-session, never committed: `plan.json`, `review.json`, `docs-updated.json`,
`ship-ready.json`, `claimed-done`, `bypass.log`. Because `plan.json` is gitignored, the commit step copies its
acceptance criteria into the **PR body** so human reviewers see the frozen contract.

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

**State files are not locked.** `.claude/state/` is a flat directory with no file locking. Two
concurrent sessions on the same branch share `plan.json`, `review.json`, `ship-ready.json`, and
`pass-approved.json`. The failure modes are conservative (one session's stale marker blocks the
other), but simultaneous parallel-agent worktrees on the same branch can produce confusing errors.
Use separate worktrees (see git-conventions.md).

**`pass-approved.json` is not snapshotted by the marker.** The commit-gate checks pass-approval
at commit time, independently of when the marker was written. If `pass-approved.json` is cleared
between marker-write and commit (e.g., `ship-cleanup.sh` fires on an unrelated failed commit), the
human needs to type `approve-ship` again. The conservative failure mode is correct — this note is
here so it doesn't surprise you.
