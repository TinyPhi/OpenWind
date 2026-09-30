# 2026-09-30 — Issue self-assignment workflow

**Session type:** Contributor tooling
**Branch:** `feat/issue-assign-workflow`

## What landed

- `.github/workflows/issue-assign.yml`: `/take`, `/assign`, `.take` and `/unassign`, `/drop`,
  `.drop` comment commands on open issues. Maintainers (`OWNER`/`MEMBER`/`COLLABORATOR`) can
  assign or unassign others with `@user`.
- `CONTRIBUTING.md` documents the commands, and the guide was streamlined.

## Review fixes, before the first push

- Commands must be the first word on their own line. Prose ("I think /assignment is broken",
  "please do not /take this", ".takeover", "/dropdown"), quoted lines and fenced code no longer
  trigger it.
- The bot filter was `comment.user.bot`, a field GitHub doesn't send, so it never filtered.
  It is now `comment.user.type != 'Bot'`.
- Non-maintainers can only self-assign issues labelled `good first issue` or `help wanted`.
  Off-limits and human-scope trackers can no longer be claimed by any commenter.
- Before deciding, the workflow reads the issue's current assignees, labels and state (not the
  comment-time snapshot), and runs one at a time per issue (`concurrency`). Two near-simultaneous
  claims no longer both succeed.
- Failures are consistent: a policy refusal gets a 😕 reaction and a reply. An API failure also
  fails the run.
- `CONTRIBUTING.md`:
  - the dependency rules match CLAUDE.md (`teams`, `audit`, `scheduler`);
  - the commit examples pass commitlint (valid scopes, lower-case subjects);
  - `--profile reporting` is listed;
  - the claiming section describes the label rule and command format.

## Verification

- A harness ran the workflow's script against 19 scenarios with mocked GitHub APIs: 19/19 pass.
  The original script passes 5 of them.
- `actionlint`: clean.
- All five commit examples pass `commitlint`.
