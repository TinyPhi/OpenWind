---
paths:
  [
    "apps/api/**",
    "packages/auth/**",
    "packages/files/**",
    "packages/audit/**",
    "packages/secrets/**",
    "apps/worker/**",
  ]
---

# Security Rules — OpenWind Platform

These are non-negotiable and reviewed in every PR touching these paths.

**`packages/secrets/`** is the OpenBao (HashiCorp Vault fork) client wrapper. It handles
dynamic secret leases, token renewal, and secret injection at runtime. No other package
reads secrets from the vault directly — all access goes through `@platform/secrets`.
See `packages/secrets/README.md` for the API surface.

---

1. **Tenant isolation requires two layers — both are mandatory.**
   - **Explicit `WHERE tenant_id = ?` filters** in every engine query. These are the primary
     guard. Do not remove them on the assumption that RLS alone is sufficient.
   - **RLS via `set_config('app.tenant_id', …)`** set by `withTenantContext`. Second line of
     defence. `withTenantContext` and `executeRawInTenantContext` issue
     `SET LOCAL ROLE app_user` before setting the GUC (#121), so RLS is enforced even when
     `DATABASE_URL` is a superuser — `SET LOCAL ROLE` switches to the non-superuser
     `app_user` role for the duration of the transaction. Every new table storing tenant
     data also needs RLS enabled and a policy defined, and `app_user` needs the matching
     grants (see `packages/db/migrations/0019_create_app_user.sql` and later grant
     migrations, e.g. `0022_app_user_rls_grants.sql`) or writes will fail with
     permission-denied once routed through `withTenantContext`. PRs missing either layer
     are blocked. See ADR-001.

2. **Validate all external input with Zod before using it.** API inputs, webhook payloads,
   connector data, file metadata — all validated before processing.

3. **Never construct SQL strings from user input.** Use Drizzle's parameterized queries or
   the `sql` tagged template literal. The linter flags string concatenation in SQL contexts.

4. **Presigned URLs only for file access.** The S3 bucket is never public. All access goes
   through `@platform/files` which validates tenant ownership before signing.

5. **Never expose internal error details to clients.** Catch all unhandled errors at the API
   boundary, return a generic 500 with a correlation ID. Log the full error server-side.

6. **Rate limit all public endpoints.** Default: 600 req/min per tenant for standard
   endpoints (raised from 100 on 2026-08-11 — shared across every concurrently active
   user in the tenant, not per-user, and normal interactive page loads fan out to many
   parallel requests), 10 req/min for auth and webhook endpoints. Override in the route
   definition with an explicit justification comment.

7. **All secrets in environment variables.** No hardcoded credentials, tokens, or keys
   anywhere in the codebase — including tests. Read from `@platform/config` only.

---

**Return 404, not 403, for cross-tenant resources.** Returning 403 leaks the existence
of a resource belonging to another tenant. Always 404.

**Any PR touching auth, new tables, new routes, file access, or secrets must pass
`/security-review` before merge.**

---

## Threat modelling for new features (STRIDE)

Before implementing any feature that crosses a trust boundary, run STRIDE:

1. **Map trust boundaries** — where does untrusted data enter? (API inputs, webhook payloads,
   connector callbacks, uploaded files, query params)
2. **Name the assets** — what's worth stealing or corrupting? (tenant data, session tokens,
   secrets, file contents, audit log integrity)
3. **Run STRIDE** — for each boundary, ask:
   - **S**poofing — can an attacker pretend to be another tenant or user?
   - **T**ampering — can they modify data in transit or at rest?
   - **R**epudiation — can they deny an action with no audit trail?
   - **I**nformation disclosure — can they read data they shouldn't?
   - **D**enial of service — can they exhaust a resource?
   - **E**levation of privilege — can they gain permissions they weren't granted?
4. **Write abuse cases** alongside acceptance criteria — for every "user can do X" write
   "attacker attempts X on another tenant's data" and confirm it's blocked.

STRIDE is mandatory for: new tables, new API routes, auth changes, connector integrations,
any feature that reads or writes tenant-scoped data.
