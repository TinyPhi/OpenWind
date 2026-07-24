# Pending Review Findings

**Consolidated:** 2026-07-24, from a full audit of `docs/reviews/2026-06-29-consulting-review.md`,
`cto-architecture-review.md`, `product-capability-review.md`, and `ux-adoption-review.md` (all
dated 2026-06-23/29). Those four files are now removed — every finding that was already resolved
is left out entirely; this doc keeps **only what's still open**, deduplicated across the four
sources, with a note on whether it already has a tracked GitHub issue.

**Why this exists:** the audit found the security/architecture findings from these reviews mostly
became tracked issues (#120–#129) and got closed. The product/UX findings from the _same reviews,
same date_ mostly never got filed as issues at all, and have sat with zero progress since
2026-06-23 as a direct result. If you pick anything up from this list, file it as an issue first —
that's the difference between the two halves of this list.

---

## Already has a tracked issue — just needs a person

| Finding                                                                       | Issue                    | Owner          |
| ----------------------------------------------------------------------------- | ------------------------ | -------------- |
| `notify` action is a stub, Novu never wired up                                | [#125](../../issues/125) | Bikash Barnwal |
| Automation-triggered transitions absent from outbox (Phase 3A connector gap)  | [#143](../../issues/143) | Bikash Barnwal |
| 6 of 7 standard modules ship no automations, non-idempotent seed SQL          | [#161](../../issues/161) | Tushar Sharma  |
| Tender costing-review automation references nonexistent `create_child` action | [#162](../../issues/162) | Tushar Sharma  |

---

## No tracked issue yet — file before picking up

### Automation engine

- **`assign` and `create_entity` automation action types are declared but never dispatched.**
  `packages/automation-engine/src/executor.ts`'s switch has no `case "assign"` / `case
"create_entity"` — both fall through to the "unhandled action type" log branch. Only
  `notify`/`set_field`/`transition`/`webhook` are wired. (product-capability-review, easy win #2)

### Ops / infrastructure

- **No backup runbook.** No `pg_dump`/PITR/`wal-g`/`barman` procedure documented or scripted
  anywhere in the repo. ADR-001 mentions backups as a concern but nothing operationalizes it.
  (cto-architecture-review)
- **Every non-core Docker image is pinned to `:latest`** — `pgbouncer`, `openbao`, `minio` (×2),
  `novu` (×3), `mailhog`, `bull-board` in `docker-compose.yml`. No reproducible-build guarantee;
  a registry-side update can silently change local/CI behavior. (cto-architecture-review)
- **`tests/e2e/` is still empty** (only a `.gitkeep`). No end-to-end test harness exists despite
  `pnpm test:e2e` being a defined script and referenced throughout `CLAUDE.md`/agent-behaviour.md
  as part of the exit condition. (cto-architecture-review)
- **Unverified — needs re-checking, not confirmed still broken:** in-process caches (schema
  cache, entity-type cache) have no cross-instance invalidation story if the API ever runs more
  than one replica; the tenant-scoped rate limiter's middleware ordering was flagged as
  potentially bypassing tenant-key scoping (issue #22 closed 2026-05-20 predates this finding —
  could be a regression or could be already fixed, re-verify against current
  `apps/api/src/middleware/rate-limit.ts` before treating as open); `ts_rank` full-text search
  pagination has a known cliff at high offsets; `bulkUpdateEntities` has an N+1 query pattern;
  the Postgres connection pool ceiling may be too low for the target scale. (cto-architecture-review)

### Portal / UX (zero tracked issues — the ux-adoption-review's core finding)

- **Several field types are "configured" but render as plain text inputs in the portal**,
  confirmed live in `apps/portal/src/pages/records/detail.tsx`'s `FieldInput` component: `file`,
  `user_ref`, `entity_ref`, `formula`, and `lookup` all hit the `default:` case (plain
  `<input type="text">`), not a real widget. Ranked the review's #1 adoption-killer.
- **No accessibility floor on modals** — zero `role="dialog"` / `aria-modal` usage anywhere in
  `apps/admin-ui/src` or `apps/portal/src`.
- **Zero internationalization** — no `i18next`/`react-intl`/`formatMessage` dependency in either
  frontend app; all strings are hardcoded English.
- **`packages/ui` is hollow** — contains only `cn()` and a utils file, no actual shared
  component library, despite both admin-ui and portal needing consistent primitives.
- **Native `confirm()`/`alert()` used inconsistently** for destructive-action confirmation instead
  of a shared dialog component (not re-verified this pass — check before treating as still true).
- **`docker compose down` vs `docker compose down -v` foot-gun** — easy to lose all local data by
  forgetting `-v` isn't needed / is needed, depending on intent; `local-setup.md` already has a
  callout for this but the UX review flagged it as a product-level rough edge, not just a docs gap.

### ADR backlog (all from the 2026-06-29 consulting review, still open)

- ADR for the connector SDK shape (blocks 3A)
- Write `.claude/context/phase-3-primer.md` before 3A starts (required per `CLAUDE.md`'s Current
  Focus section)
- ADR-002 addendum for a design gap surfaced during the consulting review (see the review itself
  in git history for detail if picked up — not re-summarized here)
- MT-02/WE-05 triage items (see git history for the original review for detail)
- ADRs still needed for: plugin system (3B), AI layer (3C), observability (3D), rate-limiting
  strategy, notification SLA policy

---

## How to use this doc

1. Before starting anything above, run `gh issue list --state all --search "<keyword>"` to
   double check it hasn't been filed/closed since 2026-07-24.
2. File a GitHub issue before implementing — that's the exact gap that let the UX findings sit
   untouched for a month while the security findings from the same review session got fixed.
3. When something here is closed, delete its bullet (don't mark it done in place) — this doc's
   entire value is being _only_ the pending list, not a history. `week-log.md` is where closures
   get logged.
