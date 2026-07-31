# Security Group B — Critical API Access Control

> Fix four critical auth/privilege bugs in apps/api/src/ before any production deployment.

status: draft
created: 2026-07-31
updated: 2026-07-31

---

## §G Goal

Four distinct privilege holes closed; no authenticated user can exceed their granted role,
read another tenant's config, or spoof entity ownership. All four issues close in one PR
on branch `fix/PLAT-security-hardening`.

---

## §C Constraints

| constraint    | value                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| stack         | Hono · Drizzle · Zod · `@platform/auth` · `@platform/entity-engine`                      |
| auth          | `requireRole()` middleware; API key scopes mapped 1-to-1 to roles in `resolveApiKey`     |
| out of scope  | Route restructuring, new routes, UI changes, other security groups                       |
| security rule | 403 never returned for cross-tenant resources — always 404                               |
| security rule | Both tenant-isolation layers (explicit WHERE + withTenantContext) on all mutating routes |

---

## §I Interfaces

No new API surface. All changes are inside existing route handlers and schemas.

**Affected files:**

- `apps/api/src/app.ts` — route registration order (#225)
- `apps/api/src/routes/api-keys/create.ts` — scope ceiling validation (#223)
- `apps/api/src/routes/entities/create.ts` — strip `createdBy` from schema (#229)
- `apps/api/src/routes/entities/bulk-create.ts` — strip `createdBy` per item (#229)
- `apps/api/src/routes/admin/platform-settings.ts` — role guard upgrade (#231)

---

## §R Requirements

**R1 (#225): view-configs GET requires agent or admin role**
`GET /admin/view-configs/:entityType` must reject any request whose JWT role is not
`agent` or `admin`.
✓ `user`-role JWT → 403
✓ `agent`-role JWT → 200 with data
✓ `admin`-role JWT → 200 with data
✓ Unauthenticated → 401
✓ PATCH handler role requirement unchanged (`admin` only)

**R2 (#223): API key scopes are bounded by creator's roles**
A caller creating an API key cannot grant scopes that exceed their own JWT roles.
✓ `admin` user POSTs `{ scopes: ["superadmin"] }` → 403
✓ `admin` user POSTs `{ scopes: ["admin"] }` → 201
✓ `admin` user POSTs `{ scopes: ["admin", "agent"] }` → 201
✓ `superadmin` user POSTs `{ scopes: ["superadmin"] }` → 201
✓ Empty scopes array → 201 (no change)

**R3 (#229): Entity createdBy always equals authenticated user**
`POST /entities` and `POST /entities/bulk` ignore any `createdBy` value from the
request body; the authenticated `userId` is always used.
✓ Body with `createdBy: "other-user-id"` → entity stored with `createdBy = auth.userId`
✓ Body without `createdBy` → entity stored with `createdBy = auth.userId`
✓ `user`-role caller cannot elevate another user's access by setting `createdBy`
✓ `bulk-create`: same invariant holds for every item in the array

**R4 (#231): platform-settings requires superadmin role**
`GET /admin/platform-settings` and `PATCH /admin/platform-settings` reject any request
whose JWT role is not `superadmin`.
✓ `admin`-role JWT → 403
✓ `superadmin`-role JWT → 200 / successful update
✓ `agent`-role JWT → 403
✓ Cross-tenant impact blocked: no tenant admin can toggle global notification kill-switch

---

## §V Invariants

- A caller can never grant a scope/role they do not themselves hold (scope ceiling rule)
- `createdBy` on entity records always equals the authenticated user who made the request
- Routes under `/admin/*` affecting global (non-tenant-scoped) singletons require `superadmin`
- Role-restricted routes: `requireRole()` call appears **before** `zValidator()` in the handler chain

---

## §T Tasks

| id  | task                                                                                           | phase | status | depends |
| --- | ---------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Add `requireRole("agent", "admin")` to GET handler in `view-configs/index.ts`                  | 1     | todo   | —       |
| T2  | Add scope-ceiling guard in `api-keys/create.ts` — reject scopes ⊄ auth.roles                   | 1     | todo   | —       |
| T3  | Remove `createdBy` from `CreateEntitySchema`; hardcode `createdBy: userId` in handler          | 1     | todo   | —       |
| T4  | Remove `createdBy` from `BulkCreateSchema` item shape; pass `createdBy: userId` per item       | 1     | todo   | T3      |
| T5  | Change `requireRole("admin")` → `requireRole("superadmin")` on both platform-settings handlers | 1     | todo   | —       |
| T6  | Add/update tests for each fix (one describe per issue; cover allowed + denied role)            | 1     | todo   | T1–T5   |
| T7  | Run exit condition: typecheck + lint + test + test:isolation                                   | 2     | todo   | T6      |

phase gate: all tests green before marking any task done

---

## §B Bugs / Backprop Log

| id   | what failed                                          | root cause                                                               | promoted to §V?                            |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ |
| #225 | any authed user reads view-configs                   | route registered before role-guarded adminRouter — Hono first-match wins | yes — role guard before validator          |
| #223 | admin mints superadmin API key                       | scopes z.array(z.string()) with no ceiling check against caller's roles  | yes — scope ceiling rule                   |
| #229 | caller spoofs createdBy → entity access escalation   | createdBy accepted from body, used as-is in createEntity call            | yes — createdBy always = auth.userId       |
| #231 | tenant admin toggles global notification kill-switch | platform_settings is a singleton but route only required "admin"         | yes — global singletons require superadmin |

---

_spec is source of truth — update as decisions are made_
