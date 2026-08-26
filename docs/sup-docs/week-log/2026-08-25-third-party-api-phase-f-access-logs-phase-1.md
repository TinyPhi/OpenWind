## 2026-08-25 — ADR-012 Phase F: API Access Logs screen (Phase 1)

**Session type:** Feature
**Branch:** `feat/third-party-api-phase-f-access-logs` (stacked on Phase E's open PR #484)

### Completed this session

#### Phase 1 (T1-T4) implementation

- **T1** — `packages/audit/src/outcome.ts`: centralized `classifyOutcome(action)` mapping
  every current `AuditAction` to `"allowed" | "denied"`, plus `actionsForOutcome` for
  building a DB filter. Exported from `@platform/audit`.
- **T2** — `apps/api/src/routes/admin/third-party-access-logs.ts`: new admin-only,
  tenant-scoped `GET /admin/third-party-access-logs` route wrapping `queryAuditLog`
  (extended with `actingPersonId`/`outcome` filters), resolving `applicationName` via a
  tenant-scoped join against `api_keys`.
- **T3** — `apps/admin-ui/src/pages/third-party-access-logs.tsx` + client lib: filterable
  admin screen (application/person/ticket/date-range/outcome), renders anonymized rows
  without erroring (spec R6), inline residual-risk caveat (spec R5). Registered in
  `App.tsx`/`layout.tsx` nav.
- **T4** — new isolation test covering comment-post/sub-ticket-create/attachment-reference/
  transition together: each denied attempt produces zero `workflow_events` rows and
  exactly one `admin_audit_log` row.

#### Scope-expanded retrofit (discovered mid-implementation, re-approved plan-lock twice)

- **Gap found**: `comments.ts`, `children.ts`, and `attachments-reference.ts` wrote **zero**
  `admin_audit_log` entries at all (allowed or denied) — only `transitions.ts` (Phase E) did.
  R1/R3/T4's acceptance criteria assumed this data already existed platform-wide; it didn't.
  Retrofitted all three onto `transitions.ts`'s atomic allowed/denied write pattern. 6 new
  `AuditAction` values (`comment.created`/`comment.access_denied`, `child.created`/
  `child.access_denied`, `attachment.referenced`/`attachment.reference_denied`), migration
  `0079_admin_audit_log_comment_child_attachment_actions.sql`.
- **Bug found**: every third-party route (including already-open-PR `transitions.ts`) wrote
  `admin_audit_log.actorId = actingPersonId` instead of the actual API key id — despite the
  column's own doc comment stating `actorId`+`actorType` identifies the key. This made
  Phase F's own `applicationName` resolution impossible. Fixed via new
  `apps/api/src/lib/api-key-id.ts` (`apiKeyIdFromUserId`, parses `apikey:<id>` from
  `auth.userId`) across all 4 routes + `tickets.ts` (forced signature change on
  `referenceAttachments`).

#### Security review fixes

- Added explicit `eq(apiKeys.tenantId, tenantId)` to the admin route's `api_keys` join
  (was relying on RLS alone — security.md rule 1 requires the explicit filter as the
  primary guard, not incidental).
- `apiKeyIdFromUserId` now throws on a non-matching `userId` instead of silently falling
  back to the raw value — a silent fallback would corrupt `admin_audit_log.actorId`
  attribution on any future misuse rather than failing loudly.
- Accepted as pre-existing/documented residual risk: the denied-branch audit writes add a
  timing side-channel already present in `transitions.ts` (Phase E) — this diff extends,
  not introduces, that surface.

### Verification

- `pnpm typecheck`: PASS (full repo)
- `pnpm lint`: PASS (full repo, `--max-warnings=0`)
- `pnpm test`: PASS (`@platform/audit`, `@platform/api`, `@platform/admin-ui`) — one
  pre-existing, unrelated `@platform/worker` failure (missing `plugin_definitions`/
  `installed_plugins` tables in local `platform_test` DB; confirmed via direct query, not a
  regression from this work)
- `pnpm test:isolation` (apps/api): all third-party/Phase-F isolation tests pass (63/63
  across the 6 affected files); 2 pre-existing unrelated failures elsewhere in the suite
  (automation-depth-recursion timing flake, automation-max-depth-async-path) plus cascading
  FK-teardown errors from the same missing plugin-system tables — none touch
  `admin_audit_log` or third-party routes.
- `/security-review`: 4 findings, 2 fixed (tenant filter, silent fallback), 1 accepted
  (timing side-channel, pre-existing pattern), 1 informational (bounded by existing rate
  limiting).

### Next

- Phase 2 (T5-T8): misuse-alert triggers (auth-failure rate, volume-spike, tagging-cap),
  screen-level residual-risk wiring, trigger isolation tests, `/security-review` + PR.
- Open question carried forward: this branch's own migration number (`0079`) will collide
  with Phase D's scan-failure branch's `0078` and Phase E's `0078` once multiple of these
  merge — expected future renumbering, not addressed proactively (same pattern as prior
  Phase C/D/E renumbering this cycle).
