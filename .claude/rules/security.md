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

1. **RLS is not optional.** Every new table storing tenant data needs RLS enabled and a
   policy defined. PRs missing this are blocked. See ADR-001.

2. **Validate all external input with Zod before using it.** API inputs, webhook payloads,
   connector data, file metadata — all validated before processing.

3. **Never construct SQL strings from user input.** Use Drizzle's parameterized queries or
   the `sql` tagged template literal. The linter flags string concatenation in SQL contexts.

4. **Presigned URLs only for file access.** The S3 bucket is never public. All access goes
   through `@platform/files` which validates tenant ownership before signing.

5. **Never expose internal error details to clients.** Catch all unhandled errors at the API
   boundary, return a generic 500 with a correlation ID. Log the full error server-side.

6. **Rate limit all public endpoints.** Default: 100 req/min per tenant for standard
   endpoints, 10 req/min for auth and webhook endpoints. Override in the route definition
   with an explicit justification comment.

7. **All secrets in environment variables.** No hardcoded credentials, tokens, or keys
   anywhere in the codebase — including tests. Read from `@platform/config` only.

---

**Return 404, not 403, for cross-tenant resources.** Returning 403 leaks the existence
of a resource belonging to another tenant. Always 404.

**Any PR touching auth, new tables, new routes, file access, or secrets must pass
`/security-review` before merge.**
