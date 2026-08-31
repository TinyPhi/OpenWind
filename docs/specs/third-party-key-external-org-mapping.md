# Third-Party API Key — External-IdP Org Mapping

> A third-party API key can trust acting-person tokens from an IdP/org different from the
> tenant's primary login IdP, with the mapping required (not silently missing) at key-creation
> time. For platform admins provisioning third-party keys; closes a live-tested auth gap.

status: draft
created: 2026-08-31
updated: 2026-08-31

---

## §G Goal

An admin creating a third-party API key whose `oidcClientId` belongs to an IdP other than the
tenant's primary login IdP is told so and required to supply the external org mapping at
creation time — never discovers it later as an unexplained `401 Invalid token` on first use.

## §C Constraints

| constraint         | value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack              | `apps/api/src/routes/api-keys/create.ts`, `packages/auth/src/dual-identity.ts`, `packages/auth/src/jwks.ts`, `packages/db/src/schema/platform.ts` (`apiKeys`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| auth               | Additive to ADR-012/ADR-008's dual-identity model — does not touch the primary tenant↔IdP mapping (`tenants.zitadel_org_id`, `tenant-org-id-mapping.md`), which stays the fail-closed default for admin login                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| out of scope       | Self-serve UI/flow for the PRIMARY tenant↔org mapping (still deliberately manual per `tenant-org-id-mapping.md` R5) — this spec is the SECONDARY, per-key mapping only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| out of scope       | Supporting more than one external-org mapping per key (one key trusts exactly one external org, if any)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| backward compat    | A tenant that only ever uses one IdP (today's default case) needs zero new input at key-creation time — this is only required when a key's issuer differs from the platform's configured primary IdP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| known prerequisite | `packages/auth/src/jwks.ts` currently resolves ONE global JWKS source (`ZITADEL_JWKS_URL`/`ZITADEL_ISSUER`) — no per-issuer resolution exists yet. `dual-identity.ts`'s org-claim read is hardcoded to Zitadel's `urn:zitadel:iam:user:resourceowner:id` claim name — AuthNexus (and presumably other IdPs) use a plain `org_id` claim instead. Both need generalizing to resolve per the key's own issuer before this spec's validation has anything real to verify against at request time, not just at creation time. A working reference implementation of both already exists in the `nexus-OW` worktree's local fork — reconcile with it rather than re-deriving from scratch. |

## §I Interfaces

**`api_keys` gains two nullable columns** (only used together; both null = today's single-IdP
default, unchanged behavior):

```
external_issuer   text   nullable   -- the OIDC issuer this key's acting-person tokens come from,
                                     -- when different from the platform's configured primary IdP
external_org_id   text   nullable   -- that issuer's org id, compared against the token's org
                                     -- claim (claim NAME resolved per-issuer, see prerequisite)
```

**`POST /api-keys` validation** (extends the existing `CreateApiKeySchema`):

```
externalIssuer?: string (url)
externalOrgId?: string
```

At creation time, resolve the issuer for the submitted `oidcClientId` (via that issuer's own
`/.well-known/openid-configuration` if `externalIssuer` isn't explicitly given, or require it
explicitly — see §T's open resolution task) and compare against the platform's configured
primary IdP issuer:

- Same issuer (today's default case) → `externalIssuer`/`externalOrgId` must be omitted; if
  supplied anyway, `422` (don't let a key end up ambiguously double-mapped).
- Different issuer, `externalOrgId` omitted → `422 ORG_MAPPING_REQUIRED`, per the resolved
  interview decision (fail closed at creation, not at first use).
- Different issuer, `externalOrgId` supplied → stored, used at verification time.

## §R Requirements

R1: Creating a key whose `oidcClientId` belongs to the platform's primary IdP requires no new
input and behaves byte-for-byte as today.
✓ Existing `api-keys` isolation tests for the single-IdP case pass unmodified
✓ `external_issuer`/`external_org_id` are `NULL` on a key created this way

R2: Creating a key whose `oidcClientId` belongs to a different IdP than the platform's primary,
without supplying `externalOrgId`, is rejected at creation — not silently accepted.
✓ `POST /api-keys` with a foreign-issuer `oidcClientId` and no `externalOrgId` → `422
ORG_MAPPING_REQUIRED`, clear message naming the mismatch
✓ No `api_keys` row is written on this rejection

R3: Creating a key with a valid `externalIssuer`/`externalOrgId` pair succeeds and that mapping
is used at request-verification time instead of the tenant's primary org mapping.
✓ `POST /api-keys` with both fields set → `201`, row has both columns populated
✓ A subsequent `requireActingPerson` check for that key compares the token's org claim (read via
the per-issuer claim-name resolution from the prerequisite) against `external_org_id`, not
`tenants.zitadel_org_id`

R4: Supplying `externalIssuer`/`externalOrgId` when the key's issuer already matches the
platform's primary IdP is rejected, not silently accepted or silently ignored.
✓ `422` with a message explaining the mapping is unnecessary for this issuer

R5: The primary tenant↔org mapping's fail-closed behavior (`tenant-org-id-mapping.md` R2) is
unaffected for keys that don't use this new mapping.
✓ Existing isolation tests for `tenant-org-id-mapping.md` pass unmodified

## §V Invariants

- A key has at most one external-org mapping — never ambiguous, never multiple candidate orgs to
  check against.
- The primary tenant↔org mapping (`tenants.zitadel_org_id`) is never written to or read from by
  this feature's code path — this is strictly additive, a second independent mapping, not a
  replacement or an alternate write path for the first one.
- A key's acting-person verification NEVER silently falls back from a missing external mapping
  to the tenant's primary org id when the issuers actually differ — that would re-introduce
  exactly the confusing cross-IdP 401 this spec exists to prevent, just moved to a different code
  path.

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                                                                                   | phase | status | depends  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | -------- |
| T1  | **Open resolution needed before coding**: decide how a key's issuer is determined at creation time — require `externalIssuer` explicitly in the request, or derive it from `oidcClientId` via that client's own discovery document (needs the client id to be globally resolvable to an issuer, which OIDC doesn't guarantee without already knowing which IdP to ask) | 1     | todo   | —        |
| T2  | Generalize `packages/auth/src/jwks.ts` to resolve JWKS per-issuer (cache multiple `JwksGetter`s keyed by issuer), not one static global source — reconcile with `nexus-OW`'s existing local fork implementation rather than re-deriving                                                                                                                                | 1     | todo   | T1       |
| T3  | Generalize `dual-identity.ts`'s org-claim read to resolve the claim NAME per-issuer (Zitadel: `urn:zitadel:iam:user:resourceowner:id`; AuthNexus: `org_id`) instead of hardcoding Zitadel's — reconcile with `nexus-OW`'s fork                                                                                                                                         | 1     | todo   | T1       |
| T4  | Migration: `external_issuer`/`external_org_id` nullable columns on `api_keys`                                                                                                                                                                                                                                                                                          | 2     | todo   | T1       |
| T5  | `createApiKeyHandler`: issuer-mismatch detection + `ORG_MAPPING_REQUIRED` validation (R2/R4)                                                                                                                                                                                                                                                                           | 2     | todo   | T1,T4    |
| T6  | `dual-identity.ts`: use `external_org_id` (via T3's per-issuer claim resolution) instead of `tenants.zitadel_org_id` when a key has an external mapping (R3)                                                                                                                                                                                                           | 2     | todo   | T2,T3,T4 |
| T7  | Isolation tests: R1–R5, plus explicit regression tests that `tenant-org-id-mapping.md`'s existing suite is untouched                                                                                                                                                                                                                                                   | 2     | todo   | T5,T6    |

phase gate: Phase 1 (T1–T3, the multi-issuer verification infra) must land and pass its own
tests before Phase 2 (the api_keys schema/validation layer) starts — Phase 2 has nothing real to
verify against otherwise, only a schema change with no working request-time behavior behind it.

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                       | root cause                                                                                                                                                                                                         | promoted to §V?                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Live testing against a `nexus-OW` (AuthNexus-paired) deployment: `GET /api/v1/workflows` returned `401 Invalid token` with a structurally valid, correctly-audienced, fresh token | `tenants.zitadel_org_id` for the Demo Company tenant was never populated (by design — a one-time manual op per `tenant-org-id-mapping.md`, and this tenant's admins use dev-fallback login, which never needed it) | Yes — this whole spec is the promotion: a tenant needs a mapping for every distinct IdP its third-party keys trust, not just the one its admins log in with |

---

_spec is source of truth — update as decisions are made_
