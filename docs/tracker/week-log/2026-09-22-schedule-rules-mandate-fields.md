# 2026-09-22 — Schedule rules: mandate fields + on-call team assignment

Brought `schedule_rules`' ticket template in line with manual ticket creation's mandatory
fields, per `docs/specs/schedule-rules-mandate-fields.md`.

## What changed

- `packages/scheduler`'s `TemplateSchema`: `assignee_id`/`team_id` renamed to `assignedTo`/
  `teamId`, made mutually exclusive (`superRefine`, exactly one required); added required
  `due_days` (int >= 0) and `remark` (string, first-comment text).
- `apps/worker/src/schedule-tick-worker.ts`'s `fireRule`: due date now computed as the
  fire's scheduled instant + `due_days` days; `teamId` mode writes `fields.team_id` and
  leaves assignment to the existing `entity.created` → `resolve_oncall` cascade (same path
  a manually created team-assigned ticket takes — no separate resolution logic);
  `assignedTo` mode passes assignment through directly, unchanged from before. After the
  fire commits, the `remark` is posted as the ticket's first comment via a new
  `postScheduleRemarkComment` (packages/scheduler — cannot reuse apps/api's
  `postRemarkComment` due to the apps→packages dependency direction), attributed to the
  rule's own creator (no live human actor for a scheduled fire). Best-effort — a remark-post
  failure never fails the fire.
- `apps/api/src/routes/admin/schedule-rules.ts`: updated the stale inline template ref type
  at the PATCH route's ref-revalidation branch to the renamed field names.
- `apps/admin-ui/src/pages/schedule-rules/index.tsx`: the create/edit modal's Ticket
  template section gained a User/Team assign-mode toggle, due-days numeric input, and
  remark textarea — mirroring `record-create.tsx`'s Mandate tab. Old "assign to rule
  creator" implicit behavior is gone entirely.

## Why

User-reported (live testing): schedule-rule-created tickets always assigned to the rule's
creator, with no team/on-call routing, no due date, and no first comment — inconsistent
with the mandatory-ticket-fields + team-assign-oncall-fallback work already shipped for
manual ticket creation (`b682e435`). This closes that gap rather than maintaining two
divergent ticket-creation contracts.

## Verification

- `pnpm --filter @platform/scheduler test`: 24/24 passed
- `pnpm --filter @platform/worker exec vitest run schedule-tick-worker.test.ts`: 15/15 passed
- `pnpm --filter @platform/api exec vitest run schedule-rules.test.ts`: 25/25 passed
- `pnpm --filter @platform/admin-ui exec vitest run schedule-rules`: 6/6 passed
- `pnpm typecheck`: 48/48 tasks green
- `pnpm lint`: all packages green (`--max-warnings=0`)
- `pnpm test` (full monorepo): pre-existing, unrelated isolation-suite failures only
  (`tenant-purge*`, `outbox-poller-automation-dedup-race`, `third-party-misuse-alerts` —
  stale fixture data / DB timeouts in the shared Docker Postgres instance, none of which
  touch scheduler/schedule-rules code)
- `pnpm test:isolation`: not run clean this session — pre-existing environment issue,
  not this diff (see above)

## Follow-up (same day): 2-step wizard + frequency picker

User feedback after the above landed: the modal was too long/cluttered, and it still had a
raw cron-expression textbox despite the earlier daily/weekly/monthly simplification intent
never actually having been implemented in this file.

- `apps/admin-ui/src/pages/schedule-rules/index.tsx`: split `RuleFormModal` into a 2-step
  wizard (Step 1 "Scheduling": name, description, entity type, workflow, a Daily/Weekly/
  Monthly frequency toggle + day-of-week or day-of-month + time-of-day, timezone, catch-up;
  Step 2 "Ticket template": the mandate fields from the change above). Added a small
  `StepIndicator` component. The raw cron textbox and hand-picked presets are gone —
  `buildCronExpr`/`parseCronToFrequency` convert between the friendly picker and the cron
  string the API still stores and the worker still reads (`ADR-017`: cron remains the
  canonical format; this is purely a friendlier authoring surface over the same contract).
  `parseCronToFrequency` is best-effort on edit — a 5-field cron it doesn't recognize (e.g.
  a legacy quarterly preset) falls back to Daily with the parsed time, rather than losing
  the rule.
- `apps/admin-ui/src/pages/schedule-rules/index.test.tsx`: rewrote the create-flow test to
  drive both wizard steps and assert the POST body's computed `cronExpr`; added a cron-
  prefill-on-edit test and a weekly-cron-computed-on-save test.

### Verification

- `pnpm --filter @platform/admin-ui exec vitest run schedule-rules/index.test.tsx`: 6/6 passed
- `pnpm typecheck`: 48/48 tasks green
- `pnpm lint`: 48/48 tasks green (`--max-warnings=0`)

## Follow-up 2 (same day): timezone validation bug + entityTypeId resolved server-side

Two live bugs surfaced while testing the above in the browser.

**Bug 1 — timezone validation rejected valid zones.** `packages/scheduler/src/timezone.ts`'s
`isValidTimezone` checked membership in `Intl.supportedValuesOf('timeZone')`, but that
enumeration's choice of canonical vs legacy alias name varies by ICU build — this server's
build lists `Asia/Calcutta` but not `Asia/Kolkata`, even though both are valid, resolvable
IANA identifiers naming the same zone. A real "Asia/Kolkata" schedule rule was rejected as
"Invalid IANA timezone". Fixed by switching to a resolution-based check
(`new Intl.DateTimeFormat(..., { timeZone })`, catch → invalid) instead of exact-membership
— accepts anything the runtime can actually resolve, matching what `computeNextFireAt`'s
cron-parser call already does with the stored zone string.

**Bug 2 — entityTypeId silently wrong for some tenants.** After removing the Entity Type
picker (previous follow-up), the client auto-derived `entityTypeId` by searching
`useEntityTypes()`'s list for `name === "ticket"`. That list is paginated
(`GET /entity-types` defaults to `limit: 50`) — a tenant whose "ticket" entity type doesn't
fall within the first page never finds it, and the code silently fell back to
`entityTypes[0]`, sending an unrelated entity type and failing
`validateScheduleRuleRefs`'s "entityTypeId must reference the ticket entity type" check.
Fixed properly rather than patched around: `entityTypeId` is now optional on
`POST /admin/schedule-rules`'s wire contract; the admin-ui no longer sends it at all, and
`apps/api/src/routes/admin/schedule-rules.ts` resolves the tenant's "ticket" entity type
itself (own-tenant-or-global-template row, matching `validateScheduleRuleRefs`'s existing
lookup semantics) when it's omitted, returning a clear 422 on `entityTypeId` if no such
type exists for the tenant.

### Verification

- `pnpm --filter @platform/scheduler exec vitest run timezone.test.ts`: 4/4 passed
- `pnpm --filter @platform/scheduler test`: 25/25 passed
- `pnpm --filter @platform/api exec vitest run schedule-rules.test.ts`: 27/27 passed
- `pnpm --filter @platform/admin-ui exec vitest run schedule-rules/index.test.tsx`: 8/8 passed
- `pnpm typecheck`: 48/48 tasks green
- `pnpm lint`: 48/48 tasks green (`--max-warnings=0`)
- Verified directly in the running `ow-backend` container (post-rebuild): compiled
  `timezone.js` resolves `Asia/Kolkata` correctly; confirmed via container logs that a live
  request after the rebuild still hit the intended container (ruled out stale-container
  confusion before finding the real second bug).

## Follow-up 3 (same day): schedule_rules RLS policy never allowed the worker to see any due rule

User created a real schedule rule and asked to verify it actually fires. It never did —
tracing it down surfaced a structural bug unrelated to any of the day's earlier changes.

**Root cause.** `ow-worker` connects to Postgres as `app_user` (RLS-enforced, no
`BYPASSRLS`). `schedule_rules`' RLS policy (migration 0101) was a bare
`tenant_id = current_setting('app.tenant_id')` match with no exemption for an unset tenant
context. But `apps/worker/src/schedule-tick-worker.ts`'s `schedulerTick` (the due-rule poll)
and `claimRule` (claim + advance `next_fire_at`) both deliberately run with **no** tenant
context — a documented, intentional cross-tenant batch pattern ("the worker legitimately
processes rules for every tenant in one pass"). Under that policy, `current_setting(...)` is
NULL/empty, `tenant_id = NULL` is never true, and the poll returned **zero rows on every
tick, forever** — the temporal scheduler could not fire a single rule in this deployment.
Verified directly: the identical due-rule query run as `app_user` returned 0 rows for a rule
that was objectively overdue; the same query under an RLS-exempt role found it immediately.

This is the exact same bug class migration 0058 already fixed for
`outbox_events`/`dead_letter_events` (also legitimately polled with no tenant context, by
`outbox-poller.ts`/`notification-poller.ts`) — `schedule_rules` was simply never given the
same fix when it was created.

**Fix.** `packages/db/migrations/0109_schedule_rules_rls_null_guc_fix.sql` — gives
`schedule_rules_tenant_rls` the identical 3-branch exemption 0058 uses: match required when
`app.tenant_id` is a real value, allowed when it's NULL (backend never touched the GUC) or
`''` (touched earlier in this pooled connection's lifetime, per 0058's own documented
pgbouncer/`set_config` placeholder quirk). Tenant isolation is unchanged for any session
with a real tenant context — verified directly (a session scoped to an unrelated fake
tenant still sees 0 rows).

Applied directly to the running dev DB (`psql -f` inside the `ow-database` container) for
immediate retesting, in addition to the migration file for the normal `pnpm db:migrate`
path on other environments.

### Verification

- Direct SQL: `app_user`-role due-rule query returned 0 before the fix, 1 after
- Direct SQL: a session with `app.tenant_id` set to an unrelated tenant still returns 0 rows
  (isolation unaffected)
- `pnpm --filter @platform/api exec vitest run tests/isolation/schedule-rules.isolation.test.ts`: 11/11 passed
- `pnpm --filter @platform/worker exec vitest run schedule-tick-worker.test.ts`: 15/15 passed
- `pnpm --filter @platform/db typecheck`: clean
- Live: the worker's next tick after the fix picked up the user's real, previously-stuck
  rule and processed it (result: `skipped`, not `success` — that specific execution had
  already crossed the 2×tick-interval overdue threshold during the ~13 minutes the RLS bug
  blocked it, and this rule has `catchUp: false`, so the miss was correctly skipped rather
  than backfilled; this is expected behavior, not a new bug — the rule's `next_fire_at`
  correctly advanced to its next real occurrence)

## Follow-up 4 (same day): entity type must follow the selected workflow, not be hardcoded to "ticket"

User verified end-to-end that a rule fires correctly (previous follow-up), but the created
ticket was missing from its own workflow's records list in the UI.

**Root cause.** The workflow picked for the rule ("test") belongs to entity type "test"
(`c7c61e94-...`), but this feature's entityTypeId resolution (previous follow-up) always
resolved to the tenant's "ticket" entity type (`aae50310-...`) regardless of which workflow
was selected — a leftover of the original 3F spec's "auto-creation of any entity type other
than ticket is out of scope" framing. The resulting entity_instances row had
`entity_type_id = ticket` but `workflow_id` pointing at a workflow built on a completely
different entity type — an inconsistent combination invisible under that workflow's own
records list. User pushed back correctly: manual ticket creation isn't restricted to one
entity type either (record-create.tsx works for any workflow/entity type), so schedule
rules shouldn't be either — the platform-wide principle is "entity type follows the
selected workflow."

**Fix.**

- `packages/scheduler/src/cross-tenant-refs.ts` — removed `validateScheduleRuleRefs`'s
  `entityType.name !== "ticket"` rejection entirely.
- `apps/api/src/routes/admin/schedule-rules.ts` — new `resolveEntityTypeId`: explicit
  `entityTypeId` (back-compat) → else the selected workflow's own `entityTypeId` → else the
  tenant's "ticket" entity type as the final default when no workflow is chosen at all.
  Wired into both POST (create) and PATCH (persists a re-resolved `entityTypeId` whenever
  `workflowId` changes, so a rule's stored entity type can never drift out of sync with its
  current workflow after an edit either).
- Documented, not silently expanded: team-assignment via the on-call cascade still only
  resolves for the "ticket" entity type specifically, because that's how the existing
  `resolve_oncall` automation rule's own `trigger_config` is scoped
  (`modules/helpdesk/seed/003_automation_rules.sql`) — a pre-existing, platform-wide
  limitation, identical to what manual team-assign creation already has for any non-ticket
  entity type. This change does not touch or expand that scoping.
- Data fix: corrected the one already-created mismatched `schedule_rules` row
  (`entity_type_id` updated to match its actual `workflow_id`'s entity type) so it's
  consistent going forward; the one already-created orphaned test ticket from before the
  fix was left as-is (stale test data, not a real record).

### Verification

- `pnpm --filter @platform/scheduler test`: 25/25 passed
- `pnpm --filter @platform/api exec vitest run schedule-rules.test.ts`: 31/31 passed
  (4 new: derives entityTypeId from workflow; falls back to ticket type with no workflow;
  PATCH re-resolves entityTypeId when workflowId changes; PATCH leaves entityTypeId alone
  when workflowId isn't part of the update)
- `pnpm --filter @platform/api exec vitest run tests/isolation/schedule-rules.isolation.test.ts`: 11/11 passed
- `pnpm typecheck` / lint (api, scheduler): clean

## Next

- Docs marker + commit still pending explicit user go-ahead to commit.
