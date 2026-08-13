# Week-log entries (one file per session)

**Why this directory exists:** [`../week-log.md`](../week-log.md) used to be a single file that
every session prepended an entry to. Two branches doing that from the same parent commit hit the
exact same insertion point — an almost-guaranteed merge conflict. That got materially worse once
tracks (3B/3C/3D) started running in parallel branches instead of sequentially. This directory
replaces that pattern going forward: **one file per session/PR, named by date.** Two parallel
branches each creating their own new file never collide — there's no shared line to fight over.

`../week-log.md` is frozen — history through 2026-08-13 lives there unchanged, do not add to it.
Everything from 2026-08-14 onward goes here instead.

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
ls docs/sup-docs/week-log/ | sort -r   # newest first
```

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
