## 2026-09-01 — Third-party API access logs: audit-hook bug, legacy-data hardening, full read/write logging

**Session type:** Bug fix + feature follow-up on ADR-012 Phase F
**Branch:** `tushar`

### Context

Live UI testing of the admin-ui API Keys → Access Logs screen (built earlier this session)
surfaced a 500 on `GET /admin/third-party-access-logs`, followed by a user question after the
500 was fixed — "someone accessed our data and we aren't logging it, is that a security issue?" —
that turned into a scoped feature: log every third-party request, not just mutations.

### Bug 1 — `createEntity`'s audit hook used `createdBy`, not `actorId`

`packages/entity-engine/src/engine.ts`'s `fireEntityAuditHook` call (in `createEntity`) ignored
its own `input.actorId` parameter and fell back to `input.createdBy` for the audit row's
`actorId`. Every other write path (`comments.ts`/`children.ts`/`attachments-reference.ts`/
`transitions.ts`) already used `applicationActorId` correctly per Phase F's own B2 invariant —
this 5th path (ticket creation, via `createEntity` rather than a direct `writeAuditEntry` call)
was missed because B2's fix swept for `writeAuditEntry` call sites, not indirect ones. Fixed the
hook plus `tickets.ts`'s own call site (which was also passing `actingPersonId` instead of
`applicationActorId`). Both bugs had to be fixed together — the route only reaches the correct
value once, but the engine was discarding it either way.

### Bug 2 — legacy corrupted rows still 500'd after the fix

The above bug had already written rows with a non-uuid `actor_id` (a Zitadel person id) into
`admin_audit_log` in production. Postgres rejects an `IN (...)` comparison against a `uuid`
column when one of the values isn't a valid uuid — so even after the code fix, the admin route
crashed on any tenant with pre-existing bad rows, restart or no restart. Fixed by filtering to
well-formed uuids before the `api_keys.id` lookup; non-matching legacy rows resolve to
"(unknown application)" instead of crashing the whole page.

### Feature — read requests previously wrote no audit trail at all

Confirmed via code read: `GET /tickets/:id`, `GET .../tickets`, `GET /workflows`, `GET
.../fields`, and `GET /attachments/:id/download` never called `writeAuditEntry`, allowed or
denied — a compromised/leaked third-party key could read every ticket in a tenant with zero
trace. This was Phase B/F's actual documented scope (R7's wording only ever discussed writes),
not a regression — flagged to the human, who decided to close the gap rather than accept it.

Added 6 new `AuditAction` values (migration 0089): `ticket.viewed`/`ticket.view_denied`,
`ticket.listed`, `workflow.listed`, `workflow_fields.listed`,
`attachment.downloaded`/`attachment.download_denied`. New `classifyRequestKind` helper in
`@platform/audit` (mirrors `classifyOutcome`'s exhaustive-map pattern exactly) derives read vs.
write from the action name — not a second stored column. Wired audit writes into all 5 read
routes, following the existing "write on success, write `*_denied` only on a real ACL denial,
never on a genuinely-missing-resource 404" convention. Tenant-wide reads with no single
ticket/workflow resource (the `GET /workflows` list) use `resourceType: "tenant"` with the
tenant's own id as `resourceId`, since the column is `NOT NULL uuid` with no bare-tenant
sentinel otherwise available.

Admin route: dropped the hardcoded `resourceType: "ticket"` filter (now only applied when a
`ticketId` filter is actually given, to avoid one resourceId value coincidentally matching
across resource types) so workflow/tenant/attachment rows show up in the unfiltered list; added
a `type=read|write` query filter.

Admin-ui: switched the access-logs table from cursor-based "Load more" (append-only) to real
Previous/Next pagination at 20 rows/page — implemented as a client-side cursor stack over the
existing efficient cursor-paginated backend, not SQL `OFFSET` (a known perf cliff on a growing
audit-log table). Added a Type (Read/Write) filter dropdown and a colored Type pill per row.
Resolves acting-person ids to org member display names (`GET /users`) and makes the Ticket
column a clickable link that resolves the record's entity type on click (`GET /entities/:id`)
and navigates to `/records/:typeSlug/:id`; non-ticket rows show `(workflow)`/`(tenant)`/
`(attachment)` instead of a broken link.

### Gotchas discovered

- **`meta/_journal.json` isn't optional.** Adding a new migration `.sql` file alone does nothing
  — Drizzle's migrator reads the journal, not the migrations directory by filename. The
  migration silently no-op'd (`db:migrate` reported success) until the journal entry was added.
  Cost real time diagnosing a "the migration ran but the constraint didn't change" mystery.
- **`third-party-misuse-alerts.isolation.test.ts` is flaky independent of this work** — confirmed
  by reproducing the failure against unmodified `HEAD` with fully flushed Redis state. Not fixed
  here (out of scope); flagged for separate follow-up.
- A suspicious `dotenv`-style tip line (`auth for agents [www.vestauth.com]`) appeared in a
  migration script's console output mid-session — flagged to the human before proceeding;
  confirmed as a benign placeholder.

### Verification

- `pnpm typecheck` / `pnpm lint`: clean, full monorepo
- Isolation tests: 217 passing across `third-party-*`/`api-key-*`/`admin-audit-log*`/`audit-log*`
  suites (excluding the pre-existing flaky misuse-alerts file), including new prove-it regression
  tests for every fixed/added audit-write path
- Admin-ui: 253 passing (full suite)
- Verified end-to-end against live server + real (previously-corrupted) production data via a
  temporary in-container probe script (removed after use): `GET
/admin/third-party-access-logs?limit=50` returns 200 with the previously-crashing rows resolved
