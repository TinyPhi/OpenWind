# 2026-10-12 — Audit `action` filter (Option D, PR 1 of 3 for #571 T33)

**Session type:** Code
**Branch:** `feat/PLAT-audit-action-filter`

- Added an optional `action` filter (one `AuditAction`, or an array in code) to `queryAuditLog`, and
  `?action=` to `GET /admin/audit`. It ANDs with every other filter, including the existing derived
  `outcome` and `requestKind` sets (so `action` plus `outcome` is an intersection, not a replacement).
  An empty array matches nothing. `ALL_AUDIT_ACTIONS` is now exported from `@platform/audit`.
- **Why this PR exists.** #571 T33 (per-ticket "notification failed" badge) needs "this ticket's
  `notification.channel_failed` entries in the last 24 hours". The admin endpoint had no action filter,
  so the badge would have had to page the whole log client-side. This builds the filter once, in the
  shared query, so the badge's narrower staff endpoint (PR 3) and the admin audit view use the same code.
- **Validation is a 400, not a 422.** I first wrote 422 from the project's general guidance; the
  repo's `zValidator` wrapper returns `400 VALIDATION_ERROR` with a `fields` array, which is what the
  route test now asserts. An unknown action is rejected (not an empty page), and so are a repeated
  `action` parameter and an empty one.
- **The OpenAPI entry does not list the action names.** `/openapi.json` is served unauthenticated and
  the set of audit actions is internal, so the parameter is documented as a string; the route
  validates against the real list. (A hand-kept enum would also drift.)
- **No migration, no new index.** Measured on Postgres 16.13 with 300k synthetic rows (100k in the
  tenant), as `app_user` with RLS active, one run each, so treat the numbers as indicative:
  - tenant + resource_type + resource_id + action + last 24 h (the badge's shape): uses
    `audit_log_tenant_resource_idx`; 4 buffer hits, 0.15 ms.
  - the same **without `resource_type`**: still uses that index, but the middle column is skipped, so
    it reads the tenant's whole slice of the index: 419 buffer hits, 8 ms (about 100 times more).
    The route comment now says to pass `resourceType` with `resourceId`.
  - tenant + a rare action with **no time bound**: walks `audit_log_tenant_created_idx` newest-first
    filtering on action, so a very rare action on a large tenant can scan far; pass `from`.
- **Noticed, not changed:**
  - The OpenAPI entry documents `cursor` as a `date-time`, but the route takes a row uuid. Pre-existing
    and orthogonal.
  - **Cursor pagination skips rows that share a `created_at`** (found in review, then reproduced on a
    real database: 3 tied rows paged one at a time return 1). `created_at` defaults to `now()`, the
    transaction start time, so several audit rows written in one transaction tie. Pre-existing, in every
    cursor-paged caller; this PR does not cause it, but a narrow filtered slice makes paging over ties
    more likely. Fixing it properly changes the cursor to keyset pagination on `(created_at, id)`, so it
    is filed on its own as #878.
  - A bad `action` returns zod's default 400 message, which lists the valid action names. Admin-only, and
    it helps an admin fix a typo, so left as is; the unauthenticated OpenAPI entry deliberately does not
    list them.
  - The security review suggested a composite `(tenant_id, action, created_at)` index if the audit table
    grows large; an unbounded query for a rare action on a big tenant scans newest-first. Not needed now.
- Tests: 9 route tests (new file; the route had none): admin-only, pass-through with the tenant taken
  from auth and a query-string `tenantId` ignored, combination with resource filters, 400 on an unknown,
  repeated or empty action. 11 real-database tests: one action, several, with resource and time filters,
  intersection with `outcome`, empty list, no matches, paging without mixing actions, and tenant
  isolation (same action and same ticket id in another tenant never leaks; RLS hides tenant B's rows
  from a tenant A session even when the explicit filter asks for them). Mutation-checked: the condition
  never applied, several actions using only the first, `action` replacing `outcome`, an empty list
  meaning "no filter", the route not passing the value, and the route accepting any string each fail
  at least one test.

- **Review (security and correctness lenses; claims checked against the code or the database):**
  security found nothing blocking (tenant condition and RLS preserved, `tenantId` only from auth,
  `requireRole` runs before validation so a non-admin never sees the enum, no enum in the unauthenticated
  spec); correctness found no defect in the new code and confirmed `ALL_AUDIT_ACTIONS` equals the 65
  actions in migration 0140's CHECK. The one real finding was the pre-existing cursor tie bug above. I
  also made the cross-tenant isolation assertion explicit (tenant A must get exactly its two entries).
