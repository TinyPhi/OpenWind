# 2D — No-Code Builders + Reporting

> Config-driven tools for admins to build workflows and automation rules, and for agents to save, filter, and export data — without writing code.

status: approved
created: 2026-06-16
updated: 2026-09-08

> **2026-08-19: Metabase → Apache Superset.** Metabase's free/OSS tier only supports static,
> non-interactive embeds — the per-tenant, row-level-filtered interactive embedding this track
> needs is gated behind Metabase Pro. Superset's guest-token embedding + built-in Row Level
> Security covers the same requirement in the open-source tier, consistent with the platform's
> self-hosted/OSS-first stack (Zitadel, OpenBao). Nothing under this track was built yet, so
> this is a full rewrite of the Metabase sections below, not a migration. See issue #106.

---

## §G Goal

Phase 2 exit gate. Pilot customer can:

- Build and modify workflows on a drag-and-drop canvas (admin)
- Create and manage automation rules through a form UI (admin)
- Save named filter+sort views on any entity list (agent/customer)
- Export any entity list as CSV, Excel, or PDF (agent/customer)
- View per-tenant and per-user performance dashboards via Apache Superset (admin/agent)

All builders write to tables the existing engines already read — zero new engine code.

---

## §C Constraints

| constraint     | value                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack          | React + Refine (admin-ui), React (portal), Hono API, Drizzle, Postgres                                                                                                                                                                                                                                                                                                                           |
| canvas lib     | ReactFlow (MIT) — preferred; fall back to form-based if timeline at risk                                                                                                                                                                                                                                                                                                                         |
| excel export   | SheetJS (xlsx community) streamed from API —**NOTE: SheetJS CE is SSPL v1; evaluate ExcelJS (MIT) as drop-in alternative before T4**                                                                                                                                                                                                                                                             |
| pdf export     | pdfkit, server-side, landscape for wide tables                                                                                                                                                                                                                                                                                                                                                   |
| superset       | OSS (free), add to docker-compose; guest-token embedding via `@superset-ui/embedded-sdk` + Row Level Security clauses                                                                                                                                                                                                                                                                            |
| superset auth  | backend holds a Superset **service account** (logs in via `/api/v1/security/login` to mint guest tokens) — machine-to-machine only, invisible to end users; credential is a Zod-validated env var read through `@platform/config`, same as every other platform credential (**revised 2026-09-08** — previously specified OpenBao; see §B B1)                                                    |
| export row cap | 10 000 rows hard limit; warning banner at 5 000                                                                                                                                                                                                                                                                                                                                                  |
| large export   | async: queue job → notify user → download link (avoids browser timeout)                                                                                                                                                                                                                                                                                                                          |
| auth           | **Zitadel only for end users** — all existing `requireAuth()` + `requireRole()` middleware, no new user-facing auth primitives. The Superset service-account login above is not user auth: no OpenWind user ever logs into Superset directly or sees a Superset login screen — the backend calls Superset on their behalf to mint an embed token, same as any other internal service credential. |
| out of scope   | AI rule generation (3C), live rule simulation, scheduled/emailed reports, public share links for views, per-field Superset permissions                                                                                                                                                                                                                                                           |

---

## §I Interfaces

### Automation rule shape (existing `automation_rules` table)

```
triggerType: string          // "entity.created" | "entity.updated" | "workflow.transitioned" | ...
triggerConfig: JSONB         // { entityTypeId, fieldName?, fromState?, toState? }
conditions: JSONB | null     // [{ field, op, value }]
actions: JSONB               // [{ type: "notify"|"set_field"|"transition", config }]
priority: int                // lower = higher priority; exposed in builder
isEnabled: bool
```

### Saved view shape (new `saved_views` table)

```
id, tenant_id, entity_type_id, created_by (user_id FK ON DELETE SET NULL),
name, filters JSONB, sort JSONB,
is_shared bool,
created_at, updated_at
```

### Export API

```
GET /entities/:typeId/export?format=csv|xlsx|pdf&[filter params]
→ 200 file stream  (sync, ≤ 5 000 rows)
→ 202 { jobId }   (async, > 5 000 rows)

GET /exports/:jobId/download
→ 200 signed URL redirect when ready
→ 202 { status: "pending" } while processing
```

### Superset embedding

```
GET /superset/guest-token?dashboard=tenant|user
→ { token, embedUrl }   // Superset guest token, RLS clause scoped to tenant_id (+ user_id for per-user dashboard)
```

Backend flow: service account login (`/api/v1/security/login`) → mint guest token
(`/api/v1/security/guest_token/`) with an RLS clause embedding `tenant_id` (and `user_id` for
the per-user dashboard) → return token + embed URL to the frontend, which renders it via
`@superset-ui/embedded-sdk`.

#### Access gate

`requireAuth()` then `requireRole("agent", "admin")` — the existing middleware, no
reporting-specific auth primitive (§C `auth`). A `user`/customer role gets 403; admin-ui
additionally redirects them off the page rather than rendering an empty shell.

Role gates **access to the endpoint only — it does not narrow the data.** Which RLS clause
applies is decided by the `dashboard` query param, not by the caller's role, so an agent may
open the tenant-wide dashboard. That is the intended behaviour for R17–R19; role-derived data
scoping is not in this track.

#### RLS clause construction

| `dashboard` | clause(s) carried by the guest token                          |
| ----------- | ------------------------------------------------------------- |
| `tenant`    | `tenant_id = '<tenantId>'`                                    |
| `user`      | `tenant_id = '<tenantId>'` **and** `assigned_to = '<userId>'` |

`tenantId` and `userId` come from the verified JWT, never from query params or body — the same
rule §V states for exports. The `dashboard` param is the only client-supplied input and is a
two-value enum, rejected otherwise.

Both ids are UUID-format-checked before interpolation. The clause is a SQL fragment Superset
splices into its own queries, so it gets input validation even though it originates from a
signed token — defence in depth, not distrust of the JWT.

#### Service-account credential

Machine-to-machine only: it never reaches the browser, and no OpenWind user holds it or any
signing secret. That part of §C/§V holds regardless of where the value is stored.

**Stored as an env var, read through `@platform/config`** — same as every other platform
credential (DB, Redis, Zitadel). Decided 2026-09-08, replacing an earlier OpenBao requirement in
§C/§V; see §B B1.

The reason is that OpenBao here does a different job. `@platform/secrets` exports only
`encryptCredential`/`decryptCredential` (OpenBao **Transit**), which scrambles tenant-supplied
connector credentials before they are written to the DB. There is no secret-fetch-by-path
helper, so honouring the original wording would have meant building one and making Superset the
only platform credential sourced differently from all the rest. `code-style.md` also requires
that config be read through `@platform/config` rather than `process.env`.

#### Environment variables

| var                                 | purpose                                      | secret |
| ----------------------------------- | -------------------------------------------- | ------ |
| `SUPERSET_SITE_URL`                 | base URL the API and the iframe both address | no     |
| `SUPERSET_SECRET_KEY`               | Superset's own Flask session key             | yes    |
| `SUPERSET_GUEST_TOKEN_SECRET`       | HS256 signing key for guest tokens           | yes    |
| `SUPERSET_SERVICE_ACCOUNT_USER`     | M2M login user                               | no     |
| `SUPERSET_SERVICE_ACCOUNT_PASSWORD` | M2M login password                           | yes    |

All five are declared in `packages/config/src/env.ts` and mirrored in `.env.example`. Every one
ships a working dev default, so a fresh `docker compose up` starts without configuration — which
also means **the three secrets are dev-weak until overridden**. `SUPERSET_GUEST_TOKEN_SECRET` is
the one that matters most: anyone holding it can forge a guest token carrying any RLS clause,
which defeats R18. It must be overridden per environment before this reaches a real tenant.

#### Three-call mint sequence

The guest-token endpoint requires a CSRF token even though the request already carries a Bearer
token:

1. `POST /api/v1/security/login` → `access_token`
2. `GET /api/v1/security/csrf_token/` (Bearer) → `result`
3. `POST /api/v1/security/guest_token/` (Bearer + `X-CSRFToken`) → `token`

Skipping step 2 fails step 3.

#### Two UUIDs per dashboard — not one

Each dashboard carries **two** distinct uuids, and they are not interchangeable:

| uuid           | consumed by                             | source                                                                 |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| dashboard uuid | guest token's `resources[].id`          | `dashboards.uuid`                                                      |
| embedded uuid  | the sdk's iframe route `/embedded/<id>` | `embedded_dashboards.uuid`, created by `EmbeddedDashboardDAO.upsert()` |

Verified against Superset 4.0.2 (`security/manager.py`'s `validate_guest_token_resources`,
`daos/dashboard.py`). The guest-token endpoint accepts either uuid via a `Dashboard.get()`
fallback, so mixing them up **mints a valid token and then 404s the iframe** — a silent failure
that leaves no error on the token path. Both uuids are pinned as fixed constants in the seed
script and in the API rather than discovered at runtime.

A dashboard is not embeddable until `upsert()` has run against it; enabling embedding is a seed
step, not a property of the dashboard row.

#### Embed origin allow-list

The origins passed to `upsert()` must match `CORS_OPTIONS.origins` in Superset's config. A host
present in one but not the other fails at iframe load, not at token mint.

#### Guest role

`GUEST_ROLE_NAME = "Public"`, and `Public` holds **zero** permissions. This is deliberate: a
guest token grants exactly the dashboard named in `resources` plus the RLS clause attached to
that token, and nothing more. No RLS rules are stored in Superset — every filter arrives
per-request on the token, which is what makes R18 hold. Granting `Public` any permission would
widen every guest token at once.

**Resolved 2026-09-08** (was an open question — the embedded-sdk's refresh behavior isn't
publicly documented). Verified against a live Superset 4.0.2 instance plus the sdk source
(`@superset-ui/embedded-sdk@0.4.0`'s `guestTokenRefresh.js`):

- guest token TTL is **300s** (`GUEST_TOKEN_JWT_EXP_SECONDS` default), not the 10 minutes the
  original Metabase plan assumed.
- the sdk schedules its own refresh by decoding the token's `exp` and re-calling the host's
  `fetchGuestToken` 5s before expiry (10s floor). **Do not hardcode a refresh interval** — the
  9-minute timer the Metabase plan called for would have expired the token 4 minutes early.
- minted token audience is `http://0.0.0.0:8080/` (Superset config default, not our site URL) —
  noted because it looks wrong but is not validated against the browser origin for guest tokens.

### Saved views API

```
GET    /saved-views?entityTypeId=
POST   /saved-views          { name, entityTypeId, filters, sort, isShared }
PATCH  /saved-views/:id
DELETE /saved-views/:id
```

---

## §R Requirements

### Export

R1: Any entity list can be exported as CSV, Excel (.xlsx), or PDF
✓ Download starts within 3 s for ≤ 5 000 rows (sync stream)
✓ Returns `202 { jobId }` for > 5 000 rows; UI polls and shows "preparing export" state
✓ All three formats contain identical row data
✓ Active filters from the list view are applied to the export — export never returns more rows than the visible list

R2: Export respects tenant isolation
✓ Row set is scoped to `tenantId` from auth context — impossible to export cross-tenant rows
✓ Isolation test: Tenant A export request cannot return Tenant B rows even with a crafted `entityTypeId`

R3: PDF handles wide tables gracefully
✓ Landscape orientation when column count > 6
✓ Column headers truncated at 20 chars with ellipsis; cell values truncated at 40 chars

R4: Export cap enforced
✓ Requests for > 10 000 rows return `400 { error: "EXPORT_TOO_LARGE" }` with message explaining the limit
✓ UI shows warning banner when filtered list count is between 5 000 and 10 000

---

### Saved Views

R5: Any user can save a named filter+sort combination on an entity list
✓ Saved view persists across sessions (page reload, new browser tab)
✓ View name is unique per user per entity type (duplicate name → inline validation error)

R6: Saved views can be shared with all agents on the same tenant
✓ Shared view appears in the view selector for all users on that tenant
✓ Only the owner or a tenant admin can edit or delete a shared view
✓ Deleting the owner's account does not delete shared views — ownership transfers to `null` (view persists)

R7: Saved views are tenant-isolated
✓ Isolation test: Tenant A's shared views do not appear for Tenant B users with the same entity type slug

---

### Automation Rule Builder

R8: Admin can create an automation rule via UI without writing JSON
✓ Trigger picker covers all `triggerType` values exposed by the automation engine
✓ Condition builder supports: equals, not equals, contains, greater than, less than, is empty
✓ Action builder supports all three action types: notify, set_field, transition
✓ Saved rule appears in `/automation-rules` list immediately

R9: Rules can be toggled on/off without deleting
✓ Toggle updates `is_enabled` in < 500 ms with optimistic UI
✓ Disabled rule does not fire (verified by existing automation engine tests)

R10: Priority order is visible and editable
✓ Rules list shows priority value; admin can drag-to-reorder or set numeric value
✓ Priority change persists after page reload

R11: Builder is extensible — new trigger types and action types can be added without rewriting the builder
✓ Trigger types and action types are driven by a config registry (not hardcoded switch/case in UI)
✓ Adding a new entry to the registry adds it to all dropdowns with no other UI changes

---

### Workflow Canvas Editor

R12: Admin can view a workflow as a canvas with states as nodes and transitions as edges
✓ Canvas renders all states and transitions for a workflow on load
✓ Layout is auto-arranged on first load (dagre or similar); positions saved on manual drag

R13: Admin can add, rename, and delete states via the canvas
✓ New state appears as a node immediately; persisted on save
✓ Deleting a state that has active instances shows a blocking error (`WORKFLOW_STATE_IN_USE`), does not delete
✓ Terminal states visually distinguished (e.g. double-border or filled)

R14: Admin can add and edit transitions by drawing edges
✓ Drawing an edge from node A to node B opens a transition config panel: label, allowed roles, required fields, SLA hours
✓ Circular transitions (A → B → A) are valid and render without visual glitch

R15: Workflow changes are saved atomically
✓ Canvas save either persists all changes or none — partial saves never occur
✓ Unsaved changes are indicated (dirty state badge); navigating away prompts confirmation

R16: Canvas degrades gracefully on large workflows
✓ Workflows with up to 20 states and 40 transitions render without layout thrashing
✓ Workflows beyond this threshold show a warning and fall back to the form-based list editor

---

### Superset Dashboards

R17: Superset OSS runs as a docker-compose service; admin UI embeds dashboards via guest token
✓ `docker compose up` starts Superset alongside existing services
✓ Embedded iframe renders in admin UI without requiring a separate Superset login
✓ Backend service-account credential is server-side only, read via `@platform/config` — never reaches the browser (**revised 2026-09-08**, see §B B1)

R18: Tenant dashboard is scoped to that tenant's data only
✓ Superset Row Level Security clause on `tenant_id` is applied server-side when minting the guest token
✓ Isolation test: guest token for Tenant A cannot be replayed to view Tenant B's dashboard

R19: Per-user performance dashboard shows individual metrics
✓ Dashboard filtered to `assigned_to = currentUserId` — shows assigned records, completed transitions, SLA adherence
✓ Token includes `user_id` RLS filter; the embedded-sdk refreshes it from the token's own `exp` (300s TTL, refresh 5s early) — no hardcoded interval on our side

---

## §V Invariants

- Export rows always scoped by `tenantId` from auth — never from query params
- Saved views never leak across tenant boundaries regardless of `entityTypeId` collision
- Workflow state deletes blocked when active instances exist (`WORKFLOW_STATE_IN_USE`)
- Automation rule builder writes to `automation_rules` table only — no engine code changes
- Superset service-account credential is server-side only, read via `@platform/config`; the client never holds it or a signing secret
- All new tables have `tenant_id NOT NULL`, RLS policy, and `tenant_id` index
- Export async path must clean up temp files/S3 objects after download or after 24 h TTL

---

## §T Tasks

| id  | task                                                                                                                  | phase | status  | depends |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----- | ------- | ------- |
| T1  | `saved_views` migration (table + RLS + indexes)                                                                       | 1     | todo    | —       |
| T2  | Saved views CRUD API (`/saved-views`) + isolation tests                                                               | 1     | todo    | T1      |
| T3  | Saved views UI — selector, save modal, share toggle (admin-ui + portal)                                               | 1     | todo    | T2      |
| T4  | Export API — sync stream ≤ 5k rows (CSV + xlsx + PDF), async 202 path                                                 | 1     | todo    | —       |
| T5  | Export UI — format picker button on entity list pages, async polling banner                                           | 1     | todo    | T4      |
| T6  | Automation rule builder UI — trigger picker, condition builder, action builder                                        | 2     | todo    | —       |
| T7  | Rule list page — enable/disable toggle, priority drag-to-reorder                                                      | 2     | todo    | T6      |
| T8  | Trigger/action type config registry (extensibility layer)                                                             | 2     | todo    | T6      |
| T9  | ReactFlow canvas — state nodes + transition edges, auto-layout (dagre)                                                | 3     | todo    | —       |
| T10 | Canvas edit ops — add/rename/delete state, draw/edit/delete transition                                                | 3     | todo    | T9      |
| T11 | Canvas save (atomic), dirty state indicator, nav-away guard                                                           | 3     | todo    | T10     |
| T12 | Large-workflow fallback (> 20 states → form-based editor)                                                             | 3     | todo    | T10     |
| T13 | Add Superset OSS to docker-compose + seed default dashboards; service-account credential via `@platform/config`       | 4     | partial | —       |
| T14 | `/superset/guest-token` API — service-account login + guest token with tenant + user RLS clauses                      | 4     | partial | T13     |
| T15 | Superset embed UI in admin-ui — tenant dashboard + per-user dashboard tab (`@superset-ui/embedded-sdk`)               | 4     | partial | T14     |
| T16 | Superset token refresh — TTL/refresh semantics confirmed (300s, sdk self-schedules); isolation test still outstanding | 4     | partial | T15     |

**T13–T15 remaining work** (each built far enough to run, none complete against this spec):

- **T13** — service, datasets, both dashboards and both embedded configs seed correctly, and the
  credential question is settled (§B B1). One gap left: the dashboards contain **no charts**, so
  both tabs render empty (§B B3).
- **T14** — route is built, mints correctly-scoped tokens, and is served at the spec path
  `/superset/guest-token` (§B B2). JWT verification against Zitadel's JWKS now works (§B B4).
  Remaining: the `user` dashboard still fails its own id check — see §B B5.
- **T15** — both tabs, sdk mount and token refresh are in place and pointed at the spec path.
  Renders empty until T13's charts exist.

phase gate: all unit + integration + isolation tests pass before advancing

---

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                              | root cause                                                                                                                                                                                                                                                                                                                                                                                                                            | promoted to §V?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | §C and §V required the Superset service-account credential in OpenBao; the implementation reads env vars                                 | `@platform/secrets` only does OpenBao **Transit** encrypt/decrypt for tenant connector credentials stored in the DB — there is no secret-fetch-by-path helper, and `code-style.md` routes all platform credentials through `@platform/config`. The invariant was written before that gap was known.                                                                                                                                   | **Resolved 2026-09-08 — spec amended, code unchanged.** §C and §V now specify an env var read via `@platform/config`. Rejected the alternative (build a KV-fetch capability) as new plumbing that would make Superset the only platform credential sourced differently from every other. Revisit only if all platform credentials move to the vault.                                                                                                                                             |
| B2  | Guest-token route served at `/reporting/guest-token`, spec says `/superset/guest-token`                                                  | route authored under a `reporting` router without re-checking the spec path                                                                                                                                                                                                                                                                                                                                                           | **Resolved 2026-09-08 — code amended to match spec.** Mount moved to `/superset` in `app.ts`; admin-ui page and both test files updated, 10 tests green. The source directory stays `apps/api/src/routes/reporting/` — the spec fixes the URL, not the file layout, and `reporting` is still the user-facing feature name.                                                                                                                                                                       |
| B4  | Every authenticated call failed — JWT verification could not fetch Zitadel's signing keys (`getaddrinfo ENOTFOUND host.docker.internal`) | `.env` set `ZITADEL_URL=http://host.docker.internal:8080`, which compose interpolates into `ZITADEL_JWKS_URL`. That hostname does not resolve inside the API container (no `extra_hosts` mapping), so the key fetch died before any signature check ran.                                                                                                                                                                              | **Resolved 2026-09-08 — config only.** `ZITADEL_URL=http://zitadel:8080` (the Docker service name, reachable on the shared `openwind_zitadel` network). No code change was needed: `jwks.ts` already rewrites the `Host` header to `ZITADEL_ISSUER`'s hostname when the fetch address differs, which is what Zitadel's host-based instance routing requires. Verified by the error changing to `JWSSignatureVerificationFailed` — keys fetched, signature checked, bad token correctly rejected. |
| B5  | `dashboard=user` can never succeed — always returns `REPORTING_UNAVAILABLE`                                                              | `buildRlsRules` validates `userId` with a UUID regex, but `userId` is Zitadel's `sub` claim, which is a numeric snowflake id (e.g. `386221876596178947`), never a UUID. `tenantId` is unaffected: it is a real tenant UUID in both dev (`DEV_TENANT_ID`) and production (mapped via `lookupTenantIdByOrgId`). Missed because the route test fixture uses an invented UUID (`22222222-…`) as `userId`, a shape Zitadel does not issue. | Open — breaks R19. Fix is the id-format check plus the test fixture that hid it.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| B3  | Both dashboards seed successfully but render empty                                                                                       | seed script creates the dashboard rows with `position_json` referencing `chartId` 1 and 2, and never creates those charts. No `Slice` rows exist, and `docker/superset/dashboards/` holds only a README.                                                                                                                                                                                                                              | No — incomplete seed, tracked under T13. R17's "embedded iframe renders" passes on an empty dashboard, so this slipped through as green.                                                                                                                                                                                                                                                                                                                                                         |

---

_spec is source of truth — update as decisions are made_
