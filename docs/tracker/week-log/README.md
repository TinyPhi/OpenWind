# Week-log entries (one file per session)

**Why this directory exists:** [`archive/week-log.md`](archive/week-log.md) used to be a single file that
every session prepended an entry to. Two branches doing that from the same parent commit hit the
exact same insertion point — an almost-guaranteed merge conflict. That got materially worse once
tracks (3B/3C/3D) started running in parallel branches instead of sequentially. This directory
replaces that pattern going forward: **one file per session/PR, named by date.** Two parallel
branches each creating their own new file never collide — there's no shared line to fight over.

`archive/week-log.md` is frozen — history through 2026-08-13 lives there unchanged, do not add to it.
Everything from 2026-08-14 onward goes here instead. `archive/` also holds bulk-archived
tables moved out of other docs (e.g. the 2026-08-24 roadmap-tracker history). Those are
reference material, not session entries. Closed months live in `archive/` too (see
[Monthly roll-up](#monthly-roll-up)); this directory holds only the current month's entries.

## Naming

`YYYY-MM-DD-<slug>.md` — date the session/PR happened (merge date, not necessarily the date the
entry was written, if they differ), slug is the issue number or a short track/feature name.

Examples:

- `2026-08-14-issue-366-connector-polling-scheduler.md`
- `2026-08-15-3b-plugin-lifecycle-service.md`

## Reading the log chronologically

There's no index file to keep in sync — an index would just reintroduce the same shared-file
problem this directory exists to avoid. List the directory sorted by name instead:

```bash
ls docs/tracker/week-log/ | sort -r   # newest first
```

For a closed month, start with its summary, `archive/YYYY-MM.md`.

## Monthly roll-up

About a week after a month ends (so late-merging PRs' entries have landed), one docs-only PR:

1. Writes `archive/YYYY-MM.md`: one or two pages grouped by track, covering what shipped (with
   PR/issue numbers), decisions, and what carried into the next month. Every number is checked
   against GitHub. Current status stays in `roadmap-tracker.md`, not here.
2. `git mv`s that month's entries into `archive/YYYY-MM/`, keeping them intact and searchable.
   Fix any relative link the move breaks (the files sit two levels deeper).

Never roll up the month still in progress: that brings back the shared-file conflicts this
directory exists to avoid. `archive/week-log.md` stays frozen.

## Entry format

Same shape `week-log.md` used — copy the structure of its most recent entries:

```markdown
## YYYY-MM-DD — <title>

**Session type:** ...
**PR:** ...
**Branch:** ...

<narrative — what shipped, why, what broke and how it was fixed, what's deliberately not done>
```

One entry per file. Keep the `## YYYY-MM-DD — <title>` line as the first line of the file even
though the filename already carries the date — it's what makes concatenating a few files with
`cat` still read naturally.

## Parallel-track note

If you're working a track (3B/3C/3D, etc.) on its own branch alongside others, this directory
already solves your merge-conflict problem for the log itself. The one place concurrent tracks
can still collide is `roadmap-tracker.md`'s Summary scorecard — see that doc's "How to update
this doc" section for the convention (edit only your own row).
