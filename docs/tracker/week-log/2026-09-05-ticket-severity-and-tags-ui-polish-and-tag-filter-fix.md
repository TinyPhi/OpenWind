# 2026-09-05 — Ticket severity + tags: post-launch UI polish + tag filter fix

Track: `ticket-severity-and-tags` (docs/specs/ticket-severity-and-tags.md), phase 3
follow-up after 64fccfc7/183ade59/4f1e7ff3.

## What shipped

- **Tag filter bug fix (behavior change, R6 revised):** the records-page tag filter was
  exact-match, which reads as broken against a live/debounced type-ahead input — every
  keystroke before the full tag is typed returned 0 results. Changed to substring match
  (`ILIKE '%...%' ESCAPE '\'`, wildcard-escaped via a new `escapeLikePattern()` helper) in
  both `packages/entity-engine/src/engine.ts`'s `listEntities` and
  `apps/api/src/routes/entities/my-tickets.ts`'s own inline query. Added a `.max()` length
  bound to the tag filter query param in both routes for consistency with tag-creation's
  `TagTextSchema` (found in security review, low severity — the value was already
  parameterized, so no injection risk, just an inconsistent bound).
- **Records-page filter panel redesign:** converted the single filter popup into an
  accordion (Date/Source/Severity/Tag/Assigned-to sections, independently collapsible) —
  the flat layout had become hard to scan as filters accumulated.
- **Records-page reload/focus-loss fix:** the single data-loading `useEffect` re-ran the
  entire workflow+fields+users+records fetch chain (and toggled a blocking loading state)
  on every filter keystroke, causing a full-page white-flash and dropping input focus.
  Split into a workflow-shell effect (runs once per `workflowSlug`) and an independent
  records-refresh effect (runs on filter/scope changes only, non-blocking
  `recordsRefreshing` indicator instead of remounting the page).
- **Records-page severity display:** replaced the text severity badge on ticket cards with
  a colored left border (severity color already existed; this avoids redundant text badges
  now that severity and tags are both visible on cards).
- **Ticket-detail tag UI redesign:** moved tag-add from an inline input row into a small
  modal (triggered from the existing kebab menu, alongside Edit/Alert), auto-closing on
  successful add. Tags render as colored, pointed "price-tag"-shaped chips (deterministic
  per-tag-text hue via string hash, WCAG-luminance-based black/white text contrast) in a
  horizontal row under the ticket's top card.

## Spec/doc updates

- `docs/specs/ticket-severity-and-tags.md` R6 rewritten to describe substring matching +
  wildcard escaping (revised from the original exact-match design).
- `docs/specs/ticket-severity-and-tags-tasks.md` T10's description updated to match.

## Verification

- `pnpm typecheck` — 44/44 packages clean.
- `pnpm lint` — clean, `--max-warnings=0`.
- `pnpm --filter @platform/entity-engine test` — 224/224 pass (includes 2 new isolation
  tests: substring-match across partial lengths, literal `%`/`_` treated as literal chars).
- `pnpm --filter @platform/admin-ui test` — 278/278 pass.
- `pnpm test:isolation` (apps/api) — not runnable on this Windows host per CLAUDE.md's
  existing note ("Windows: run isolation/e2e in CI or WSL2"); the new isolation test file
  was confirmed to reach the DB layer correctly locally (fails only at the pre-existing
  local Postgres role/credential step common to every isolation file on this host, not
  specific to this diff) and will run for real in CI.
- `/security-review` (security-reviewer subagent): no blocking findings. Verified the new
  ILIKE tag condition stays AND'd into existing tenant/access-scope guards, confirmed
  `escapeLikePattern` covers all ILIKE metacharacters and is applied via parameterized
  Drizzle `sql`, confirmed no new XSS surface in the tag-color helpers or tag rendering.
  One low-severity finding (missing `.max()` on the tag filter param) fixed immediately.
