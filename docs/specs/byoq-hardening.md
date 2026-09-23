# BYOQ Hardening (correctness, injection pattern, role scoping)

> Build Your Own Query returns a fabricated number for one measure, builds SQL by hand-escaped string interpolation, and has no endpoint-level role gate — fix all three, and lock the existing admin-sees-everything / user-sees-own-data scoping in with tests.

status: draft
created: 2026-09-21
updated: 2026-09-21 (dropped the org/mine scope toggle — admin is always full-tenant, user is always self-scoped, no client-chosen override)

---

## §G Goal

`POST /api/reporting/query` (BYOQ) returns correct numbers for every measure it advertises,
builds its dynamic SQL through parameterized bindings instead of hand-rolled string escaping,
and enforces the same role allowlist the Superset dashboard path already enforces. Data scope
stays exactly what it is today, just locked in and verified: `admin`/`agent` always see the
full tenant, a `user`-role caller always sees only their own (created or assigned) tickets —
no client-supplied field chooses between the two.

## §C Constraints

| constraint                              | value                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack                                   | Hono route (`apps/api/src/routes/reporting/query.ts`), Drizzle (`sql` template), `@platform/auth`                                                                                                                                                                                                                                                   |
| auth                                    | `requireAuth()` already present; roles arrive from Zitadel's `urn:zitadel:iam:org:project:roles` JWT claim via `packages/auth/src/jwks.ts:291-292` — never invented or stored locally                                                                                                                                                               |
| existing precedent                      | `apps/api/src/routes/reporting/guest-token.ts` already does the equivalent split for the Superset dashboards: `requireRole("agent","admin","user")` on the route, plus a server-side 403 for the tenant-wide dashboard when the caller isn't staff (`guest-token.ts:144-153`). BYOQ should match this shape, not invent a new one.                  |
| tenantId/userId source                  | Both come from `c.get("auth")`, set by `requireAuth()` from verified JWT claims — never from request body/query, so not client-forgeable                                                                                                                                                                                                            |
| out of scope (follow-up, not this pass) | Audit logging of who ran what BYOQ query. Per-request query-cost bounds (max filter count, statement timeout). Endpoint-specific rate limiting beyond whatever `requireAuth()`'s existing tenant/API-key limits already cover. Frontend UX for hardcoded status/priority filter values not being workflow-aware (separate, lower-severity finding). |

## §I Interfaces

`POST /api/reporting/query` (existing route, `apps/api/src/routes/reporting/query.ts`)

- Request/response shape is otherwise unchanged — no new client-facing field for scope.
  `meta.isScopedToUser` (already in `BYOQueryResponse`) continues to be the only signal the
  client gets about which scope applied, computed server-side from role, same as today.
- `measure` enum unchanged (`tickets | resolution_time | sla_margin | total_hours`), but
  `sla_margin` now computes a real value instead of a placeholder (see R1).
- Error responses no longer include `err.message` from the underlying DB driver — replaced
  with a fixed, non-leaking message plus a server-side log entry carrying the real detail.

## §R Requirements

R1: `sla_margin` and `total_hours` measures both return real values — neither silently falls
through to the placeholder `measureCol = "1"`.
✓ `sla_margin`: `ticket_base` CTE joins `workflow_states.sla_hours` and exposes an
`sla_margin_hours` column, matching `docker/superset/bootstrap.py`'s `sla_margin_hours`
formula (SLA target minus time to close, closed tickets with a real SLA target only).
`measureCol` has a branch for `input.measure === "sla_margin"` pointing at that column.
✓ A ticket with a workflow that sets `sla_hours` and has closed: `sla_margin` measure with
`operation: average` returns `sla_hours - actual_hours_to_close`, not `1`.
✓ A ticket with no SLA target or still open: excluded from the aggregate (NULL), matching the
existing `sla_margin_hours` column's own documented scoping in `bootstrap.py`.
✓ `total_hours`: either given a real `measureCol` (e.g. `tb.resolution_time_hours`, reusing the
same column `resolution_time` already computes, since this dataset has no separate
dwell-time source the way `docker/superset/bootstrap.py`'s `entity_instances`-wide
`total_hours` does) or explicitly rejected by the schema (`z.enum` drops `total_hours`) if no
sensible column exists — either way, it must stop being silently reachable via
`measureCol = "1"`. Decision recorded once made (see §Open questions).

R2: All dynamic SQL in `query.ts` is built through Drizzle's parameterized `sql` template
(tagged-template `sql` calls with bound `${value}` placeholders), not `sql.raw()` concatenated
with hand-escaped strings.
✓ `sqlEscape()` helper is removed.
✓ Every filter value, `userId`, and `tenantId` reaches the database as a bound parameter, never
string-interpolated into the SQL text.
✓ A filter value containing a single quote, e.g. `O'Brien`, returns correct filtered results
(proves parameterization works, not just that injection fails).
✓ A filter value crafted as a classic injection probe (e.g. `' OR '1'='1`) matches literally
that value or nothing — never widens the result set or errors the query.

R3: The BYOQ route is gated by the same role allowlist as the dashboard path.
✓ `requireRole("agent", "admin", "user")` added to `executeBYOQueryHandler`'s middleware chain,
matching `guest-token.ts:119` exactly.
✓ A caller with none of those three roles gets `403` before any query runs — not a 200 with
self-scoped (and therefore empty-looking, silently-wrong) results.

R4: Role-based data scope is fixed by role alone, with no client-controlled input into it.
✓ `admin`/`agent` always get tenant-wide results, unfiltered by `created_by`/`assigned_to` —
unconditionally, not behind any request field.
✓ `user` (or any role without admin/agent) always gets self-scoped results — unconditionally.
✓ The self-filter (`created_by = userId OR assigned_to = userId`) is applied identically to all
three internal queries (summary, groups, rows) — never just the row list.
✓ Nothing in the request body — no field, no header — can move a `user`-role caller's results
outside their own created/assigned tickets.

R5: Server errors returned to the client never contain raw driver/DB error text.
✓ Catch block returns a fixed `{ error: "QUERY_EXECUTION_ERROR", message: "..." }` with a
generic message; the real `err` is logged server-side (`logger.error`) with tenant/user
context for debugging, not shipped to the browser.

## §V Invariants

- Tenant isolation is never expressed as a string-interpolated value in SQL text — `tenantId`
  reaches the database the same parameterized way as any user-supplied filter value, per R2.
  This closes the one place `tenantId` was previously interpolated directly
  (`query.ts:350`, `WHERE ei.tenant_id = '${tenantId}'`) even though it was not client-input at
  the time — the invariant is about the pattern, not just today's exploitability.
- Data scope is derived from role alone (`isPrivileged = roles.includes("admin") ||
roles.includes("agent")`), never from anything in the request body — there is no field for a
  caller to request a different scope than their role allows, so there is nothing to fail
  closed on. Simpler than a client-chosen-and-server-verified field, and closes the same class
  of bug for good rather than per-field.
- Every one of the three queries built per BYOQ request (summary/groups/rows) shares one
  `whereSql` construction — a future added query for this endpoint must reuse the same builder
  rather than re-deriving filters, or it silently reopens the scoping gap R4 closes.

## §T Tasks

| id  | task                                                                                                                                                                                                                                                     | phase | status | depends |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Add `workflow_states.sla_hours` join and `sla_margin_hours` computed column to the `ticket_base` CTE in `query.ts`; wire `measureCol` for `sla_margin`. Decide and implement `total_hours` (real column or drop from schema) per the open question below | 1     | done   | —       |
| T2  | Replace `sqlEscape()` + `sql.raw()` string building with Drizzle parameterized `sql` template across all filter branches, `tenantId`, and `userId` interpolation sites                                                                                   | 1     | done   | —       |
| T3  | Add `requireRole("agent","admin","user")` to `executeBYOQueryHandler`                                                                                                                                                                                    | 1     | done   | —       |
| T4  | Replace the catch block's `err.message` passthrough with a fixed message + server-side `logger.error`                                                                                                                                                    | 1     | done   | —       |
| T5  | Tests: `sla_margin` correctness (R1), quote-containing and injection-probe filter values (R2), 403 for a non-allowlisted role (R3), `user` role always self-scoped regardless of request body content (R4), error response contains no driver text (R5)  | 2     | done   | T1–T4   |
| T6  | Full `typecheck`/`lint`/`test` run on `apps/api`; fix any breakage; report actual pass/fail                                                                                                                                                              | 2     | done   | T1–T5   |
| T7  | Add `reporting.query_executed`/`reporting.query_failed` to `AuditAction` and both exhaustiveness maps (`outcome.ts`, `request-kind.ts`); wire `writeAuditEntry` into `query.ts` on success/failure, fire-and-forget                                      | 3     | done   | T6      |
| T8  | Cap `filters` at 20 in `BYOQuerySchema`; add `SET LOCAL statement_timeout` at the start of the query transaction                                                                                                                                         | 3     | done   | T6      |
| T9  | Tests for T7/T8; full `typecheck`/`lint`/`test` run on `apps/api` and `@platform/audit`                                                                                                                                                                  | 3     | done   | T7,T8   |

phase gate: all unit tests pass before advancing to next phase

## §Resolved decisions

- `total_hours` measure: dropped from `BYOQuerySchema`'s enum entirely, per the recommendation
  above — it was never offered in the UI, so nothing user-facing changed.

## §Follow-up (done, same session)

The three items §C originally deferred were revisited; two were built, the third turned out to
already exist:

- **Rate limiting**: not a gap. `requireAuth()`'s JWT path already calls
  `enforceTenantRateLimit()` unconditionally (`packages/auth/src/middleware.ts:592`) for every
  authenticated request, including this route — per-tenant, per-minute, Redis-backed, with an
  admin-editable override. No BYOQ-specific work needed.
- **Audit logging**: `packages/db/migrations/0115_reporting_audit_trail.sql` had already
  reserved `reporting.query_executed`/`reporting.query_failed`/`reporting.exported` in
  `admin_audit_log`'s CHECK constraint (built for Superset SQL Lab's `analytics_user` path via
  `record_reporting_audit()`), but nothing TS-side ever called it. Added the two BYOQ produces
  to `AuditAction` (`packages/audit/src/index.ts`) plus both exhaustiveness maps
  (`outcome.ts`, `request-kind.ts` — both classify as `allowed`/`read`), and wired
  `writeAuditEntry` into `query.ts` on both the success and failure paths, fire-and-forget (a
  failed audit write is logged, never surfaces as a failure of the underlying query).
  `reporting.exported` stays reserved but unused — BYOQ's CSV export is client-side only, no
  server request at all.
- **Query-cost bounds**: `filters` capped at 20 (`BYOQuerySchema`), plus a per-transaction
  `SET LOCAL statement_timeout = '5000'` at the start of the query transaction.

New tests: audit entry shape/action on success and failure, actor type for an API-key caller,
a failing audit write not failing the request, the filter cap boundary (20 accepted, 21
rejected), and the timeout statement actually being issued.

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                        | root cause                                                                                                                                                                                                                 | promoted to §V? |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| B1  | Selecting `sla_margin` **or** `total_hours` as a BYOQ measure returns plausible-looking but fabricated numbers (e.g. `AVG` returns `1`, `SUM` returns the row count) with no error | `measureCol` in `query.ts` has no branch for either measure; both fall through to the literal `"1"` default. `total_hours` isn't reachable from the current UI, but the API schema still accepts it from any direct caller | yes — R1        |
| B2  | Any authenticated caller of any role reaches the query engine, regardless of whether their role should see reporting data at all                                                   | `executeBYOQueryHandler` only has `requireAuth()`, no `requireRole()`, unlike the equivalent dashboard path                                                                                                                | yes — R3        |

---

_spec is source of truth — update as decisions are made_
