# Third-Party API — Canonical Design

> Behavioral detail for OpenWind's public/partner-facing ticket API. ADR-012 records the
> accepted decision (dual-identity auth, action-scopes, presigned attachment uploads); this
> file is the living reference for what's actually shipped, endpoint by endpoint. Each
> endpoint links to the spec that governs it — read the spec for full §R/§V detail, this file
> is the index + cross-cutting rules that apply to all of them.

status: living
created: 2026-08-30
updated: 2026-08-31

---

## Cross-cutting rules (apply to every route below)

- **Dual-identity auth**: an API key (`Authorization: Bearer sk_live_...`) identifies the
  tenant + grants scopes; `X-Acting-Person-Token` (a short-lived Zitadel/OIDC token) identifies
  the human the key is acting on behalf of. Both are required on every route unless noted.
  See ADR-012 and `packages/auth`.
- **Scopes**: each route requires one `entity:ticket:<verb>` scope, enforced by
  `requireTicketScope(verb)` (`apps/api/src/routes/third-party/require-ticket-scope.ts`), which
  also does rate-limit checks and misuse-alert recording (ADR-013).
- **Existence-oracle convention**: a resource that doesn't exist and one the acting person has
  no access to return the _identical_ 404 body — never a distinguishable 403. This applies to
  cross-tenant IDs, soft-deleted rows, and access-denied rows alike (security.md).
- **PII/financial redaction**: any field tagged `sensitivity: pii` or `sensitivity: financial`
  on `entity_fields` is replaced with `"[REDACTED]"` in every third-party response
  (`apps/api/src/lib/redact-entity-fields.ts`, `packages/workflow-engine/src/redact.ts`).
- **Internal-field stripping**: the `__accessUsers` ACL bookkeeping object (written by
  `@mention`-grant resolution) is never included in any third-party response, regardless of
  redaction rules — it's not a `sensitivity`-tagged field, so it needs its own strip step
  (`apps/api/src/lib/strip-internal-fields.ts`).
- **Rate limiting**: 3-tier (per-tenant / per-key / per-key-and-person), see ADR-013.
- **Response envelope**: `{ data: T }` on success, `{ error, message, fields? }` on error —
  same convention as the internal API (code-style.md).

---

## Endpoints

| Method & path                        | Spec                                                                                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /workflows`                     | [phase-b-core-ticket-api](specs/third-party-api-phase-b-core-ticket-api.md)                                                                                | Lists workflows visible to the tenant. Limit/offset pagination.                                                                                                                                                                                                                                                                                        |
| `GET /workflows/:workflowId/fields`  | [workflow-fields-schema](specs/third-party-api-workflow-fields-schema.md)                                                                                  | Schema-discovery endpoint — field name/type/required/config, so partners can render a create-ticket form without 422 trial-and-error. Tenant-wide visibility, no per-ticket access check. `workflowId` must be a UUID; a non-UUID segment 404s (existence-oracle), same as a genuinely unknown workflow.                                               |
| `GET /workflows/:workflowId/tickets` | [list-my-tickets](specs/third-party-api-list-my-tickets.md)                                                                                                | Mirrors the internal records-page access model: creator OR assignee OR recognized `__accessUsers` grant, unless the acting person is the workflow's admin (full visibility). Cursor pagination (`MAX_PAGE_SIZE`/`DEFAULT_PAGE_SIZE`, `packages/entity-engine`). List/get parity: a ticket only appears here if `GET /tickets/:id` would also allow it. |
| `POST /tickets`                      | [phase-b-core-ticket-api](specs/third-party-api-phase-b-core-ticket-api.md)                                                                                | Create a ticket. Idempotency-key support (TOCTOU-safe).                                                                                                                                                                                                                                                                                                |
| `GET /tickets/:id`                   | [phase-b-core-ticket-api](specs/third-party-api-phase-b-core-ticket-api.md)                                                                                | Access-list gated via `hasEntityAccess` (stricter than list's key-existence check — validates the `__accessUsers` grant's `level`).                                                                                                                                                                                                                    |
| `POST /tickets/:id/children`         | [phase-b-core-ticket-api](specs/third-party-api-phase-b-core-ticket-api.md)                                                                                | Sub-ticket creation, 1-level nesting cap. Child inherits parent's `__accessUsers` grants.                                                                                                                                                                                                                                                              |
| `POST /tickets/:id/comments`         | [phase-b-core-ticket-api](specs/third-party-api-phase-b-core-ticket-api.md)                                                                                |                                                                                                                                                                                                                                                                                                                                                        |
| `POST /tickets/:id/transitions`      | [phase-e-status-transitions](specs/third-party-api-phase-e-status-transitions.md), [transition-role-mapping](specs/third-party-transition-role-mapping.md) | Acting-person role mapping for transition guards.                                                                                                                                                                                                                                                                                                      |
| `POST /attachments/presign`          | [phase-d-attachments](specs/third-party-api-phase-d-attachments.md)                                                                                        | Presigned upload URL — see `packages/files`.                                                                                                                                                                                                                                                                                                           |
| `GET /attachments/:id/download`      | [phase-d-attachments](specs/third-party-api-phase-d-attachments.md)                                                                                        | Presigned download URL, tenant-ownership validated before signing.                                                                                                                                                                                                                                                                                     |

Key management (`api_keys` lifecycle — creation, rotation, soft-revoke, scopes) is covered by
[phase-a-key-management](specs/third-party-api-phase-a-key-management.md) and ADR-008; access
logging by [phase-f-access-logs](specs/third-party-api-phase-f-access-logs.md); general
hardening (misuse alerts, idempotency, rate-limit tuning) by
[phase-g-hardening](specs/third-party-api-phase-g-hardening.md).

The partner-facing reference doc (payload/response examples, golden-path walkthrough) lives
outside this repo at `work docs/OW/API exposur/third-party-api-reference.md` and is kept in
sync with this file whenever an endpoint is added or changed.

## Non-API alternative: hosted ticket-create handoff

Not every integration is an API integration. [hosted-ticket-create-handoff](specs/hosted-ticket-create-handoff.md)
covers a separate, non-API path: a partner sends their end user (who has a real OpenWind login —
NOT the acting-person/dual-identity model above) to `apps/admin-ui`'s own login/create page with
`workflowId`/`entityTypeId`/prefill data as query params, and OpenWind handles auth, form
rendering, and attachment upload UX itself. No new API route, no redirect back to the partner —
see the spec's §V invariants for why. Partner-facing walkthrough: reference doc §6.1a.

**As of 2026-09-02, this entry URL requires one more param: `appClientId`** — the partner's own
registered `oidcClientId` (the same value from their `api_keys` registration, same identifier
used to authenticate the direct-API path above). Without a valid, active, non-revoked one, ticket
creation through this flow is rejected outright — see
[third-party-api-origin-tagging](specs/third-party-api-origin-tagging.md) for why: every ticket
created through either path now carries a visible tag naming the application and performing
person, and this is the piece of data the handoff flow was missing to support that.

---

_This file is the canonical behavioral index referenced by CLAUDE.md and ADR-012 — update it
in the same PR as any third-party route change._
