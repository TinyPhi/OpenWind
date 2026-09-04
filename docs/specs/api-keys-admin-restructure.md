# API Keys — Admin Sidebar Restructuring & Card View

> Moves API Keys out of Settings into its own admin-only sidebar entry, splits the sidebar into
> all-roles vs. admin-only sections, and redesigns the API Keys list as a card grid grouped by
> application (one card per third-party application, not per key row), with a detail page showing
> that application's full key history and its own access logs.

status: implemented
created: 2026-09-01
updated: 2026-09-01

---

## §G Goal

An admin can find API Keys and API Access Logs under one obviously-admin-only sidebar section,
see third-party applications as first-class cards (not a flat per-key table), and drill into one
application to see every key it has ever had (created/expired/revoked/rotated) alongside its own
filtered access logs — without leaving the page.

## §C Constraints

| constraint      | value                                                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack           | `apps/admin-ui/src/{components/layout.tsx,pages/api-keys/**,components/access-logs-panel.tsx}`, `apps/api/src/routes/{api-keys/create.ts,api-keys/rotate.ts,admin/third-party-access-logs.ts}`, `packages/audit`, `packages/db` (migrations 0087/0088) |
| out of scope    | A real `applications` table — grouping stays a normalized-name convention on `api_keys.application_name`, enforced as a DB uniqueness constraint rather than modeled as its own entity                                                                 |
| backward compat | The standalone `/admin/third-party-access-logs` route and its own sidebar entry are kept, unchanged — the new `/admin/api-keys` page's "API Access Logs" internal view is an additional way to reach the same data, not a replacement                  |

## §I Interfaces

**Two new nullable-turned-constrained columns' worth of behavior on `api_keys`** (no new table):

```
application_name_active   boolean   not null default true   -- migration 0088
```

Mirrors `oidc_client_id_active` (migration 0072) exactly: a rotation's dying predecessor keeps its
`application_name` value but hands off the _uniqueness claim_ to its successor.

**New unique index** (migration 0087, refined by 0088):

```
api_keys_tenant_application_name_active_unique
  ON api_keys (tenant_id, lower(btrim(application_name)))
  WHERE revoked_at IS NULL AND application_name IS NOT NULL AND application_name_active = true
```

**`POST /api-keys` new error**: `409 APPLICATION_NAME_IN_USE` when an action-scoped key's
normalized `applicationName` collides with another active key in the same tenant under a
different `oidcClientId` — same expiry-reclaim behavior as the existing `CLIENT_ID_IN_USE` check.

**`GET /admin/third-party-access-logs`'s `application` query param** now accepts a
comma-separated list of key ids (previously exactly one), resolved via `queryAuditLog`'s widened
`actorId: string | string[]` filter (`packages/audit`).

**New routes** (admin-only, `RequireAdmin`):

```
/admin/api-keys          -- ApiKeysPage: switchable "API Keys" (card grid) / "API Access Logs" view
/admin/api-keys/:slug    -- ApiKeyApplicationDetail: one application's full key table + its own
                             access logs, locked to that application's key ids
```

## §R Requirements

R1: The sidebar visually separates all-roles navigation from an admin-only section.
✓ A labeled "Admin" section (divider + heading) renders only for `admin` role, containing Users,
System Logs, API Keys, API Access Logs
✓ An `agent` sees none of the admin-only section at all

R2: API Keys is reachable from the sidebar, not buried in Settings.
✓ Settings no longer has an "API Keys" tab
✓ `/admin/api-keys` is a real, bookmarkable, `RequireAdmin`-guarded route

R3: The API Keys page offers both the key list and the access logs without navigating away.
✓ `/admin/api-keys` renders a two-button switch; both views are the real components (card grid /
`ThirdPartyAccessLogsPage`), not a re-implementation
✓ The standalone `/admin/third-party-access-logs` route and sidebar entry keep working unchanged

R4: API Keys are grouped into one card per application, not one row per key.
✓ Two keys whose `applicationName` normalizes to the same value render as a single card
✓ Card shows the application's display name (most-recently-created key's own text), key count,
and an overall status (best-of: active > rotating > expired > revoked)
✓ Clicking a card navigates to `/admin/api-keys/:slug`

R5: An application's detail page shows its full key lifecycle and its own access logs.
✓ Every key belonging to the application (including revoked/expired/rotated-away ones) appears in
a table with the same actions (Edit/Rotate/Emergency Rotate/Revoke) the old flat list had
✓ An access-logs panel below it is locked to exactly this application's key ids — the Application
filter field is hidden (not just disabled), other filters (person/ticket/outcome/date) stay open

R6: Duplicate application registrations are rejected, not silently allowed to fragment card
grouping.
✓ `POST /api-keys` with a normalized-duplicate `applicationName` (different Client ID) in the same
tenant → `409 APPLICATION_NAME_IN_USE`, no row written
✓ Two different tenants may legitimately reuse the same application name
✓ A rotation's dying predecessor never counts as a conflict against its own successor

## §V Invariants

- `application_name_active` and `oidc_client_id_active` are handled together, always — any future
  change to one of rotate.ts's "hand off the uniqueness claim" updates must update both, or a
  rotation will start failing on whichever one was missed (this is exactly the bug this spec's own
  implementation hit and fixed — see §B B1).
- The admin-ui's application grouping (`application-grouping.ts`) and the backend's
  `normalizeApplicationName` (`create.ts`) must stay byte-for-byte identical normalization logic
  (trim + lowercase + collapse whitespace) — a drift between them would let the DB accept a name
  the UI groups differently than the DB considers a duplicate, or vice versa.
- `ApplicationGroup.slug` is always the raw normalized string, never URL-encoded — encode only at
  the point of building a `to`/`navigate()` URL. `useParams()` decodes automatically; comparing an
  encoded slug against a decoded route param never matches (see §B B2).

## §T Tasks

| id  | task                                                                                                                                                                                          | phase | status | depends |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Migration 0087: `application_name` uniqueness (tenant-scoped, normalized) + `create.ts`'s `APPLICATION_NAME_IN_USE` check with expiry-reclaim                                                 | 1     | done   | —       |
| T2  | Migration 0088: `application_name_active` flag, fixing the rotation-grace-window regression T1's plain index caused (§B B1); `rotate.ts` updated to flip it alongside `oidc_client_id_active` | 1     | done   | T1      |
| T3  | `packages/audit`'s `queryAuditLog` widened to `actorId: string \| string[]`; `GET /admin/third-party-access-logs` accepts a comma-separated `application` list                                | 1     | done   | —       |
| T4  | Sidebar split into all-roles/admin-only sections; new admin-only "API Keys" nav entry                                                                                                         | 2     | done   | —       |
| T5  | `AccessLogsPanel` extracted from `ThirdPartyAccessLogsPage` as a reusable component with an optional `lockedApplicationIds` prop; standalone page unchanged behaviorally                      | 2     | done   | T3      |
| T6  | `/admin/api-keys` route + `ApiKeysPage` (switchable Keys/Logs view); API Keys tab removed from Settings                                                                                       | 2     | done   | T4,T5   |
| T7  | `application-grouping.ts` (shared normalize/group logic) + card-grid rewrite of `apps/admin-ui/src/pages/api-keys/index.tsx`                                                                  | 2     | done   | T6      |
| T8  | `/admin/api-keys/:slug` detail page (`detail.tsx`) — full key table (moved from the old flat list) + locked `AccessLogsPanel`                                                                 | 2     | done   | T5,T7   |

phase gate: Phase 1 (schema + audit-query widening) landed and its own isolation/unit tests passed
before Phase 2 (UI) started — Phase 2 has nothing real to group/lock against otherwise.

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                                                                                                                                     | root cause                                                                                                                                                                                                                                                                                                                                                                                                                               | promoted to §V?                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| B1  | After landing T1's plain `(tenant_id, normalized name)` unique index, three pre-existing isolation suites broke: `api-key-rotate-lineage-and-emergency` (real 500 on a genuine rotation), `api-key-update`/`api-key-mint-client-id-reclaim`/`api-key-external-org-mapping` (fixture collisions) | `rotate.ts` deliberately keeps a rotated key's predecessor row active (`revoked_at` untouched) for a 24h grace window while inserting a successor under the SAME `applicationName` — a real, intentional two-active-rows-one-name overlap the plain index had no way to allow. The other three files' fixtures reused one hardcoded `applicationName` across many inserts in the same tenant, previously harmless, now a real collision. | Yes — T2 (the `application_name_active` flag, mirroring `oidc_client_id_active`) and the invariant above |
| B2  | Every isolation/detail-page test for `/admin/api-keys/:slug` initially showed "Application not found" regardless of the actual slug                                                                                                                                                             | `ApplicationGroup.slug` was built as `encodeURIComponent(normalized)`, but react-router's `useParams()` decodes path segments automatically — comparing an encoded stored slug against an already-decoded route param never matched                                                                                                                                                                                                      | Yes — see §V above                                                                                       |

---

_spec is source of truth — update as decisions are made_
