## 2026-09-15 — Schedule Rules admin UI

**Session type:** Implementation — admin-ui only
**Branch:** `feat/PLAT-612-tagsev-3f-schedule-ui` (PR 12 of the tagsev/3E+3F stack), branched off
the still-unmerged `feat/PLAT-606-tagsev-3f-schedule-routes` (PR #595) since that branch is
where the `/admin/schedule-rules` API actually lives.

### Context

Continuing docs/specs/temporal-scheduler.md's Phase 4 (UI surface): T15 (rule list + create/edit
form), T16 (execution history), T17 (next-fires preview).

### What was produced

- `apps/admin-ui/src/pages/schedule-rules/index.tsx` / `.test.tsx` — rule list (humanized cron,
  entity type, workflow, status, next fire) + create/edit form modal (cron expression with 4
  friendly presets, IANA timezone input, entity-type/workflow pickers, ticket template fields —
  title/description/severity — catchUp toggle) + pause/resume/delete actions.
- `apps/admin-ui/src/pages/schedule-rules/detail.tsx` / `.test.tsx` — per-rule page: next-fires
  preview (next 5 fires via `GET .../next-fires`) and execution history table (status, fired-at,
  linked ticket, error code) via `GET .../executions`.
- `apps/admin-ui/src/components/layout.tsx`, `apps/admin-ui/src/App.tsx` — nav + route wiring,
  admin-only (matches this router's own all-admin-only surface, including reads).

### Scope note

The next-fires preview only works in edit/detail mode — `GET /admin/schedule-rules/:id/next-fires`
requires an existing rule id, so a not-yet-saved rule (create-mode modal) has nothing to preview
against. Not a gap, a consequence of the route's own contract.

The template form only exposes title/description/severity — `assignee_id`/`team_id`/`service_id`
are supported by the schema but have no picker UI yet (would need the same team/service pickers
still blocked on the entity-engine/`packages/teams` dependency-direction question noted in PR 11's
week-log entry).

### Review findings (1 accepted + fixed, 1 deferred)

- Fixed: the edit-save path rebuilt the ticket template object from scratch, silently dropping
  `assignee_id`/`team_id`/`service_id` on every save of a rule that had them set — now spreads the
  existing template first.
- Deferred: clearing `workflowId`/`description` to empty via the form is a no-op on PATCH, because
  the server's `UpdateRuleSchema` uses `.optional()` (drops the key) rather than `.nullable()`
  (would accept explicit `null`). This is systemic — the same pattern already exists in PR 11's
  `ServiceFormModal`/`PolicyFormModal` team/workflow clearing — and fixing it requires a backend
  schema change, out of scope for an admin-ui-only PR.

### Verification

- `pnpm --filter admin-ui typecheck`: PASS
- `pnpm --filter admin-ui lint`: PASS
- `pnpm --filter admin-ui test`: PASS (39 files, 280 tests)
