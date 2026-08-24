# Third-Party API — Phase B: Core Ticket API

> Dual-identity auth middleware + the minimum third-party can create a ticket and see what it
> needs to create one correctly: list workflows, create ticket, fetch ticket detail. No
> comments/tagging/attachments/transitions yet — that's Phase C+.

status: implemented
created: 2026-08-22
updated: 2026-08-23

source: `third-party-api-design.md` (canonical behavioral spec, `work docs\OW\API exposur\`),
`third-party-api-enablement-phases.md` Phase B section + Rounds 2–9 resolutions,
`pr-chunking-and-sequencing-plan.md` Phase B row (PRs B1–B4). Design is closed — no open
behavioral questions remain for this phase. Depends on Phase A (`docs/decisions/ADR-012-...md`,
migrations 0068/0069) — all of Phase A (A1–A5) is merged into `upstream/main`; T9/T10 closeout
commits are staged on this branch's ancestry (`docs/phase-a-closeout`,
`test/phase-a-r1-r3-r9-closeout`).

---

## §G Goal

An external application, holding a Phase-A-minted API key plus a signed identity token for a
specific real person, can: list the workflows that person can access, create a ticket into one
of those workflows' initial state, and fetch a ticket's detail if that person is on its access
list. Every action is attributable to the real person + application, never a bare "api_key" or
"system" actor. No ticket-existence oracle: an inaccessible ticket looks identical to a
nonexistent one.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| stack        | Hono (`apps/api`), Drizzle (`packages/db`), Zitadel (identity token verification)                                                                                                                                                                                                                                                                                                                                              |
| auth         | dual identity every request: API key (Phase A) + Tier 1 signed person token. **No Tier 2** — dropped for good, Round 5. No new grant-via-API endpoint — never in scope, any phase.                                                                                                                                                                                                                                             |
| out of scope | comments, tagging, sub-tickets (Phase C); attachments (Phase D); transitions (Phase E); rate limiting, idempotency, PII redaction, API versioning confirmation (Phase G) — this phase's 3 endpoints exist unthrottled/non-idempotent until G lands, that's expected, not a gap to fix here                                                                                                                                     |
| existing     | `api_keys` table with `scopes`/`zitadel_client_id`/`expires_at`/`rotated_from`/`zitadel_client_id_active` (Phase A, migrations 0068/0069); `entity:ticket:<verb>` scope vocabulary (`packages/auth/src/scopes.ts`, ADR-008/migration 0055); `hasEntityAccess`/`assertRecordWorkflowAccess` shared access helpers already used by `get.ts`/`create-child.ts`; `admin_audit_log.actor_type CHECK IN ('user','api_key','system')` |

## §I Interfaces

**Dual-identity auth middleware (B1)** — new, sits in front of all 3 endpoints below:

| input            | source                                                                       | check                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| API key          | `Authorization: Bearer sk_...`                                               | exists, not revoked, not expired (reuse Phase A's rejection path — one path, not two)                                                                |
| person token     | separate header (e.g. `X-Acting-Person-Token`) carrying a Zitadel-issued JWT | signature/issuer/expiry valid (standard Tier 1 verification, same rigor as human login)                                                              |
| `aud` claim      | inside person token                                                          | must contain (string or array form) the Client ID stored against the _presented API key_ (Phase A `zitadel_client_id`) — not a shared/OpenWind value |
| `iat` freshness  | inside person token                                                          | reject if older than 15 min (config-driven), independent of Zitadel's own expiry                                                                     |
| tenant/org match | API key's tenant vs. token's org claim                                       | must match — tested as its own case, not a side effect of token validity                                                                             |

Output of successful auth: `{ apiKeyId, tenantId, actingPersonId, scopes }` attached to context,
consumed by all 3 endpoints and by the audit-log write path.

**Endpoints:**

| method                         | path            | scope required         | access rule                                                                                                 |
| ------------------------------ | --------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/workflows` (B2)   | list, paginated | `entity:ticket:read`   | returns only workflows the acting person can access — same rule as UI, no separate API-enabled flag         |
| `POST /api/v1/tickets` (B3)    | create          | `entity:ticket:create` | always targets a workflow's initial state; accepts optional assignee; creator = acting person + application |
| `GET /api/v1/tickets/:id` (B4) | detail          | `entity:ticket:read`   | access-list-gated; always 404 if person not on the list (never a distinguishable 403)                       |

**Audit/actor schema (Round 7 GAP-05):** every write from this phase records `actor_type =
'api_key'` **plus** a separate `acting_person_id` field always populated — search by person or
by key both work independently.

## §R Requirements

R1: Dual-identity resolution on every request
✓ A request missing either the API key or the person token is rejected
✓ Successful auth attaches both identities to context; every downstream write/log uses both

R2: `aud` claim checked against the specific key's registered Client ID, not a shared value
✓ A token whose `aud` doesn't include the presented key's stored `zitadel_client_id` is rejected
✓ A genuinely valid token minted for a _different_ registered application (different Client ID)
is rejected when presented against this key
✓ Both legal `aud` forms (single string, array) are accepted when they do match

R3: Token freshness check independent of Zitadel's own expiry
✓ A token with `iat` older than 15 minutes (config value) is rejected even if not yet expired by
Zitadel's own configured lifetime

R4: Tenant/org match is a distinct gate from token validity
✓ A structurally valid, unexpired, correctly-audienced token from a _different_ tenant/org than
the presented key's tenant is rejected
✓ This case has its own test — not inferred from general cross-tenant isolation coverage

R5: List-workflows returns only what the acting person can access, paginated
✓ A person with access to workflows A and C (not B) sees exactly A and C via this endpoint
✓ Each returned workflow object contains exactly `id`, `name`, and the entity type it applies to
— no state list (creation always forces initial state regardless, see R6), no other UI-only
fields
✓ Response is paginated (page size + cursor/offset, consistent with the platform's other list
endpoints) — a tenant with a large or growing number of workflows never gets an unbounded
single-page response
✓ Pagination is ordered deterministically (explicitly pick and test an order — e.g.
newest-created-first or name-ascending — do not leave default DB order unspecified; Phase A's
own PR A5 review caught a real bug from exactly this kind of unstated ordering assumption)

R6: Ticket creation always targets an initial state
✓ A create request is always placed into the target workflow's initial state — if the payload
includes any `state`/equivalent field, it is silently ignored, never honored, and never causes
a rejection (confirmed decision — force-to-initial-state unconditionally, no error path for this
case)
✓ Created ticket's creator identity is the acting person; application is recorded via the API
key used
✓ An optional assignee on the create payload is applied to the resulting ticket
✓ A key scoped to `entity:ticket:read` only (no `create` scope) is rejected on this endpoint

R7: Ticket detail fetch is access-list gated, always-404 on denial
✓ Acting person on the ticket's access list → 200 with detail
✓ Acting person not on the list → 404 (not 403), identical in shape/timing-class to a genuinely
nonexistent ticket ID
✓ A key scoped to `entity:ticket:read` succeeds here even without `create`/`comment` scopes
✓ A ticket ID belonging to a _different_ tenant than the presented key's tenant produces the
exact same 404 as an inaccessible-but-same-tenant ticket, with no separate code path — RLS makes
the cross-tenant row invisible before the access-list check runs, following the platform's
standard 404-not-403 convention (same pattern as every other cross-tenant resource-access case)

R8: Scope enforcement is real intersection, not assumed from key storage
✓ Effective permission = key's stored scopes ∩ acting person's real RBAC ∩ tenant RLS — a person
lacking real access is rejected even if the key's scopes would otherwise allow the action
✓ Each of the 3 endpoints independently enforces its own required scope — not inherited implicitly
from the auth middleware passing

R9: Actor/creator identity correctness on every write and on the created record
✓ `admin_audit_log` rows from this phase's writes carry `actor_type = 'api_key'` and a populated
acting-person field
✓ The created ticket record itself shows real person + application as creator (not a generic
"api_key" or "system" string), consumed later by Phase B's own UI tag/banner requirement (R10)

R10: UI reflects API-originated tickets distinctly
✓ Records/list page shows a small tag (e.g. "Agent") on API-created tickets
✓ Ticket detail page shows "Auto-generated by [Application Name]"
✓ Everywhere else, an API-created ticket behaves identically to a human-created one

R11: Ingress-level rejection of malformed string input
✓ Null bytes, control characters, or non-UTF-8 sequences in any string field are rejected at
ingress, before reaching entity-engine validation or being persisted
✓ This is a layer in front of render-time sanitization (R12), not a replacement for it

R12: Content submitted via API is treated as untrusted on render
✓ Ticket field values and filenames submitted via this phase's create endpoint render safely
(escaped) in admin-ui — audited specifically for `dangerouslySetInnerHTML` or equivalent
unsafe-HTML paths reachable by API-submitted values; none should exist for plain fields/filenames

R13: Payload size/depth guard ahead of entity-engine validation
✓ An oversized or excessively deep `fields` payload on ticket creation is rejected with a clear
validation error before reaching entity-engine's own validation path

R14: Generic, non-leaking error responses (owned by T1 for auth-layer cases, T4 for
create-specific validation — see §T)
✓ Bad/expired/revoked API key → generic unauthorized response, no distinguishing detail (revoked
vs. expired vs. never-existed all look the same to the caller)
✓ Missing, malformed, or invalid person-token header produces the exact same generic
unauthorized response as a bad API key — the caller cannot tell which of the two credentials
was the problem, following the platform's standard pattern for auth failures
✓ Bad field/type on ticket creation → specific, clear validation error (fine to be specific —
concerns the caller's own request shape, not internal state)
✓ Server-side failure → plain 5xx, no internal detail leaked

## §V Invariants

- Dual identity (API key + real Zitadel person token) is mandatory on every request — never a
  single-identity path, never Tier 2 fallback.
- `aud` is checked against the _specific key's_ registered Client ID, never a shared/platform
  value — this was wrong once already (Round 4→5 correction); any future touch to this check
  must re-derive from the key's own stored `zitadel_client_id`.
- Ticket-existence and access-denial are always indistinguishable to the caller (404, never 403)
  for an existing-ticket read.
- No endpoint in this phase (or any later phase) exposes a way to self-grant or escalate access
  via API — access changes are always human-approved through the existing UI flow.
- Effective permission is always the 3-way intersection (key scopes ∩ person RBAC ∩ tenant RLS)
  — never assumed satisfied by any single one of the three.

## §T Tasks

| id      | task                                                                                                                                                                                            | phase | status | depends        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | -------------- |
| T1 (B1) | Dual-identity auth middleware: token verification, `aud` check, `iat` freshness, tenant/org-match gate, generic unauthorized response for any auth-layer failure (R14 auth cases)               | 1     | todo   | Phase A merged |
| T2 (B2) | List-workflows endpoint, paginated, deterministic order (R5)                                                                                                                                    | 1     | todo   | T1             |
| T3 (B4) | Ticket detail fetch endpoint (access-list gate, always-404 incl. cross-tenant guess, R7)                                                                                                        | 1     | todo   | T1             |
| T4 (B3) | Ticket creation endpoint (force-to-initial-state per R6, scope enforcement, actor-identity correctness, payload guard, ingress rejection, UI tag/banner, R14 create-specific validation errors) | 2     | todo   | T1, T2         |
| T5      | `/security-review` (mandatory — new write + read surface), `/review`, docs marker                                                                                                               | 2     | todo   | T4             |
| T6      | Re-run Phase 0's harness against these 3 endpoints                                                                                                                                              | 2     | todo   | T2, T3, T4     |

phase gate: all unit + integration + isolation tests pass, `/security-review` clean, before
Phase C's `/spec-tasks` is frozen (per the ground rule in SESSION-CONTEXT.md — Phase C waits for
Phase B fully merged, same pattern as A→B).

**PR chunking (per `pr-chunking-and-sequencing-plan.md`):** B1 (middleware only) → B2 (list-
workflows) → B3 (ticket creation, largest) → B4 (ticket detail). B2/B4 both depend only on B1;
B3 depends on B1+B2. Chunking is a working assumption per that doc — revise if Phase A's actual
shape (now known: scopes via `entity:ticket:<verb>[]`, `zitadel_client_id`/`_active`, no stored
`status` enum) changes any of this at spec-tasks time.

## §B Bugs / Backprop Log

| id  | what failed                                | root cause | promoted to §V? |
| --- | ------------------------------------------ | ---------- | --------------- |
| —   | (none yet — implementation hasn't started) | —          | —               |

---

_spec is source of truth — update as decisions are made_
