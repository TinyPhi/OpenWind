# Tenant ↔ Zitadel Org ID Mapping

> Map Zitadel org IDs to internal UUID tenant IDs so production auth (NODE_ENV=production) works without the DEV_TENANT_ID crutch. For platform engineers/ops enabling real multi-tenant login.

status: implemented
created: 2026-07-13
updated: 2026-07-13

---

## §G Goal

A user whose JWT carries a real Zitadel org-id claim resolves to the correct
platform tenant (a UUID), with zero cross-org data visibility, without
requiring `tenant_id` columns to stop being `uuid` anywhere in the schema.
`NODE_ENV=production` becomes safe to set on the server without breaking
auth or throwing UUID-cast errors.

## §C Constraints

| constraint   | value                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------- |
| stack        | TypeScript, Hono, Drizzle ORM, Postgres, Zitadel JWT auth                                          |
| auth         | `urn:zitadel:iam:user:resourceowner:id` claim (org id) — already correctly populated               |
| schema       | No existing `tenant_id` column changes type. ADR-001's RLS design (`tenant_id::uuid`) stays as-is  |
| out of scope | Admin UI / self-serve flow for provisioning a new org+tenant. Cleanup of orphaned demo tenant/data |
| dev/local    | `DEV_TENANT_ID` fallback keeps working unchanged for local/non-production use                      |

## §I Interfaces

`tenants` table gains one nullable, unique column:

```
zitadel_org_id  text  unique  (nullable)
```

New lookup used only in the auth request path (not exported as a general
public API): given an org id, find the tenant row where `zitadel_org_id`
matches. No match → auth fails closed (see R2).

Auth context resolution (conceptual, not prescribing file layout):

```
if NODE_ENV != production and DEV_TENANT_ID set:
  tenantId = DEV_TENANT_ID        # unchanged today
else:
  tenantId = lookup_tenant_by_org_id(orgId)   # NEW
  if not found: reject request (see R2)
```

## §R Requirements

R1: A JWT carrying a real org-id claim resolves to the tenant whose
`zitadel_org_id` matches that claim.
✓ Logging in as a user in the mapped org returns that tenant's data only.
✓ No `tenant_id` column anywhere changes SQL type; existing RLS policies
unmodified.

R2: A JWT carrying an org-id claim with no matching tenant fails closed.
✓ Request is rejected with a clear, non-crashing error (not a 500, not a
silent fallback to any other tenant).
✓ No stack trace / UUID cast error reaches the client or the logs as an
unhandled exception.

R3: Local/dev workflows are unaffected.
✓ With `NODE_ENV` unset or non-production and `DEV_TENANT_ID` set, behavior
is byte-for-byte identical to today.

R4: `NODE_ENV=production` is safe to set on a real deployment once the
current org is mapped.
✓ Setting `NODE_ENV=production` + removing `DEV_TENANT_ID`, with a tenant
row mapped to the real org, results in zero UUID-cast errors across a full
manual smoke pass (login, list users, view records).

R5: The mechanism generalizes to a second, future org without code changes.
✓ Adding a new `tenants` row with a new `zitadel_org_id` is sufficient for
that org's users to get correctly tenant-scoped — no redeploy of app logic
required for the mapping itself.

## §V Invariants

- `tenant_id` columns are always `uuid`. Zitadel org ids (Snowflake strings)
  never flow directly into a `tenant_id` column anywhere.
- An unmapped org must never resolve to another org's tenant, the demo
  tenant, or any tenant at all — fail closed, not fail open.
- `DEV_TENANT_ID` must never be set when `NODE_ENV=production` (existing
  Zod refinement in `packages/config/src/env.ts` — do not weaken it).

## §T Tasks

| id  | task                                                                | phase | status                                                        | depends  |
| --- | ------------------------------------------------------------------- | ----- | ------------------------------------------------------------- | -------- |
| T1  | Migration: add nullable unique `zitadel_org_id` to `tenants`        | 1     | done                                                          | —        |
| T2  | Backfill/seed a `tenants` row for the real org (378675861571829762) | 1     | done (documented in rollout runbook, executed at deploy time) | T1       |
| T3  | Add org-id → tenant lookup + fail-closed rejection in auth path     | 2     | done                                                          | T1       |
| T4  | Preserve DEV_TENANT_ID fallback path unchanged for non-production   | 2     | done                                                          | T3       |
| T5  | Isolation tests: unmapped org rejected, mapped org scoped correctly | 2     | done                                                          | T3       |
| T6  | Manual verification plan for server rollout (NODE_ENV flip)         | 3     | done (docs/specs/tenant-org-id-mapping-rollout.md)            | T2,T3,T4 |

phase gate: all unit + integration + isolation tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed                                                 | root cause                                                               | promoted to §V? |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------ | --------------- |
| B1  | `NODE_ENV=production` would 500 every tenant-scoped request | Zitadel org id (non-UUID) assigned directly to a `uuid` tenant_id column | yes — see §V    |

---

_spec is source of truth — update as decisions are made_
