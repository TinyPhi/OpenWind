# Third-Party API — Phase A: Key Management

> Human-admin-only API key lifecycle (create/revoke/rotate/emergency-rotate/auto-expire) + a new
> Key Management admin-UI screen. Foundation for the Third-Party API ticket-lifecycle feature —
> no ticket endpoints in this phase, just the key itself.

status: draft
created: 2026-08-17
updated: 2026-08-21

source: `docs/third-party-api-design.md` §4.1, `docs/third-party-api-enablement-phases.md`
Phase A + Round 4–7 resolutions. Design is closed — no open behavioral questions remain for
this phase. **Round 7 (2026-08-18) changed this spec's permission model** — see R8, rewritten
from a coarse read-only/read-write tier to the platform's real action-scope system.

---

## §G Goal

Admin can mint/revoke/rotate/emergency-rotate a third-party API key from a dedicated UI screen.
Every key carries a set of action scopes (via simple presets), an expiry, and enough identity
metadata (app contact email + Zitadel Client ID) to support later phases' `aud` check and expiry
notifications. No ticket lifecycle logic in this phase — that's Phase B+.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | Hono (`apps/api`), Drizzle (`packages/db`), Refine+shadcn (`apps/admin-ui`)                                                                                                                                                                                                         |
| auth         | key mint/revoke/rotate = admin-role-gated human action only, never agent/bg                                                                                                                                                                                                         |
| out of scope | Tier 2 identity (dropped, Round 5); per-workflow-level scoping beyond the existing per-ticket ACL model (§4.3 of the design doc already covers this); ticket endpoints (Phase B+); expiry email notification (deferred fast-follow)                                                 |
| existing     | `api_keys` table + `POST /api-keys` exist today (see phase-3-primer.md, ADR-008); `packages/auth/src/scopes.ts` + migration 0055 already define the `entity:<type>:<verb>` scope format this phase adopts directly — this phase extends/reshapes `api_keys`, doesn't replace either |

## §I Interfaces

**`api_keys` table — new/changed columns:**

**Implementation note (PR A1, post-review — this table was written against the design doc in
isolation, before checking the current schema; the actual migration reused four existing
ADR-008 columns instead of adding parallel ones, and omitted two columns entirely as
derivable rather than stored. Corrected below to match what actually shipped in migration
0068; see that migration's own comment for the full reasoning.):**

| column                      | type                                    | notes                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `application_name`          | text, required                          | new (migration 0068)                                                                                                                                                                                                                                                                                                              |
| `application_description`   | text, optional                          | new (migration 0068)                                                                                                                                                                                                                                                                                                              |
| `application_contact_email` | text, required                          | new (migration 0068) — unblocks future expiry-notification fast-follow                                                                                                                                                                                                                                                            |
| `zitadel_client_id`         | text, required                          | new (migration 0068) — UNIQUE across active (non-revoked) keys via a partial index; see R7. Postgres partial-index predicates can't reference `now()`, so an expired-but-not-yet-revoked key's Client ID is **not** freed by the index alone — the mint endpoint (T2/PR A2) must also check for and reclaim that case explicitly. |
| `scopes`                    | text[], required, no default, non-empty | **reused, not new** — already exists on `api_keys` from ADR-008. Values from the platform's known `entity:ticket:<verb>` vocabulary — see R8. UI offers "Read-only" (`[entity:ticket:read]`) and "Read-write" (full verb set) as presets; a custom set is also allowed                                                            |
| `expires_at`                | timestamptz, nullable at the DB level   | **reused, not new** — already exists on `api_keys` from ADR-008 (`NULL` = immortal, for pre-existing legacy keys). The mint endpoint stamps `created_at + 3 months` for every third-party key it creates; the DB column itself stays nullable so no legacy row is affected.                                                       |
| ~~`status`~~                | —                                       | **not added** — fully derivable from `revoked_at`/`expires_at`/`rotated_from` at the query/API layer (T8, the UI task); a stored enum would be a second source of truth that could drift from those columns.                                                                                                                      |
| `rotated_from`              | nullable FK → api_keys.id               | **reused, not new** — already exists on `api_keys` from ADR-008, points a successor key back at its predecessor (was called `rotation_predecessor_id` above before this correction)                                                                                                                                               |
| ~~`rotation_successor_id`~~ | —                                       | **not added** — a predecessor's successor is discoverable via `WHERE rotated_from = <predecessor id>`, so a second stored pointer would just be a second place for the two to disagree with each other.                                                                                                                           |

**Admin UI — Key Management screen** (`apps/admin-ui`, new route): list + create form + row
actions (Revoke, Rotate, Emergency Rotate). See R8.

## §R Requirements

R1: Key minting is human-only, admin-role-gated
✓ No code path outside the admin-UI-driven `POST /api-keys` (or equivalent) can create a key
✓ Attempting to mint via a non-admin role is rejected with 403
✓ No background job, worker, or automation can mint a key

R2: Revoke is instant, no grace
✓ A revoked key's very next request (in-flight or new) fails auth immediately
✓ No cached/stale auth state allows one extra successful request post-revoke

R3: Rotate gives the old key a 24-hour grace window
✓ Old key continues authenticating for exactly 24h from rotation timestamp
✓ At the 24h boundary (not a moment before/after), old key fails auth exactly like a revoked key
✓ New key is immediately active from the moment of rotation

R4: Rotation lineage is capped at two keys (one dying, one active) — never three
✓ Rotating key X (issuing Y) while X's own predecessor W is still inside its grace window is
disallowed by construction: at most one "dying" key exists in a lineage at any time
✓ If Rotate is triggered on an active key that is itself inside another key's grace window as
the successor, OR if a second Rotate is triggered while the first predecessor is still dying,
the still-dying predecessor is killed instantly (not left to finish its 24h), and the new key
becomes sole active member of the lineage
✓ `rotation_predecessor_id`/`rotation_successor_id` never form a chain longer than 2 nodes

R5: Emergency Rotate is a distinct action from Rotate, with lineage-aware taint
✓ Emergency Rotate kills the target key instantly (zero grace), distinct code path from Rotate's
grace-window logic — no shared branch that could silently inherit a grace period
✓ New key is issued immediately as part of the same action
✓ UI shows an explicit "integration breaks now" warning before confirming
✓ If the emergency-rotated key has a live successor (i.e. it was mid-grace as a Rotate
predecessor), that successor is also killed instantly and a genuinely new key is issued in
place of both — not just the one key clicked

R6: Keys auto-expire at exactly 3 months from generation
✓ A key stops authenticating at its exact `expires_at` timestamp, not a day early/late
✓ Expired key fails auth via the same rejection path as a revoked key (no separate "expired"
branch that could drift in behavior)
✓ No notification is sent on expiry in this phase (explicitly deferred — do not build)

R7: Key creation requires a formal application record, validated
✓ Creation is rejected (clear validation error) if `application_name`, `application_contact_email`,
or `zitadel_client_id` is missing
✓ Creation is rejected if `zitadel_client_id` matches another currently-active key's
`zitadel_client_id` (uniqueness constraint — prevents two apps silently sharing one Client ID,
which would undermine Phase B's `aud` check)
✓ `application_contact_email` is validated as a plausible email shape (basic format check, not
live-verified)

R8: Key permissions are the platform's real action-scope system, not a separately-built tier
✓ Creation is rejected if `scopes` is omitted or empty
✓ Every scope string in `scopes` must belong to the known `entity:ticket:<verb>` vocabulary
(`create`, `read`, `comment`, `transition`, `subticket`, `attach`); an unknown scope string is
rejected with a clear validation error
✓ The key-creation UI offers "Read-only" and "Read-write" as one-click presets mapping to
`[entity:ticket:read]` and the full verb set respectively — but the stored data model is
always a scopes array, never a boolean/enum tier; a custom scope set is equally valid
✓ Enforced at the request-authorization layer as scope intersection — a key scoped to
`[entity:ticket:read]` is rejected on every create/comment/attach/transition/sub-ticket action
attempted in later phases, regardless of the acting person's real access (full enforcement
lands with Phase B's endpoints; this phase guarantees scopes are stored, validated against the
vocabulary, and immutable post-creation)
✓ No coarse read-only/read-write boolean or enum exists anywhere in the schema — the preset is
UI sugar only, never a second source of truth alongside `scopes`

R9: Disconnecting/decommissioning an application kills its key instantly
✓ Same rejection path as Revoke — no grace, regardless of whether the key was mid-rotation-grace
at the time

R10: Key Management UI shows full lifecycle state at a glance
✓ List shows, per key: application name, created-by (human), created-at, expiry date, scope
preset/summary, status (active/rotating/expired/revoked), Revoke/Rotate/Emergency-Rotate
actions
✓ A key within 30 days of `expires_at` shows an amber "Expires in N days" state
✓ A key past `expires_at` shows a red "Expired" state
✓ Both expiry states are computed from the already-stored `expires_at` — no new backend field

R11: Every key is uniquely attributable in downstream logs (data-model requirement for Phase F)
✓ Each key has a stable, distinguishable ID separate from its application name — so an app
holding both a read-only-scoped and a read-write-scoped key can be told apart in an
investigation (screen itself is Phase F scope; this phase just guarantees the ID exists and
is queryable)

R12: Successful authenticated responses carry an expiry header; failed ones never do
✓ Every successful, authenticated API response includes an `X-API-Key-Expires-At` header with
the key's `expires_at` value
✓ A failed/unauthenticated response (bad key, expired, revoked) never includes this header —
it must not be usable to probe or fingerprint a key from the outside
✓ (This requirement's actual header-emission point lives in Phase B's middleware, since Phase A
has no ticket endpoints to emit it from yet — this phase only needs `expires_at` to already
exist and be reliably readable, which R6 already guarantees)

## §V Invariants

- A key's `scopes` are immutable after creation (need different permissions → issue a new key,
  same as the rotation-for-tier-change pattern this replaces)
- `scopes` is never empty and never contains a string outside the known
  `entity:ticket:<verb>` vocabulary
- A key's rotation lineage never exceeds 2 live nodes (see R4) — enforce at the data-write layer,
  not just at the UI level, so no future code path can accidentally grow a 3rd generation
- Revoked/expired/emergency-rotated-away keys never re-activate through any code path
- `zitadel_client_id` uniqueness holds across active keys only — a revoked/expired key's Client
  ID becomes reusable (do not treat historical Client IDs as permanently reserved, unless a
  concrete reason to change this surfaces later)
- No code outside the admin-UI-triggered mint action can create a row in `api_keys` with
  `status = 'active'`

## §T Tasks

| id  | task                                                                                                                                                                                                                                                                                                                                                                                            | phase | status                                                                                                                                                                                                                                                                                    | depends     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| T1  | **Done (migration 0068).** Migration: add `application_name`/`application_description`/`application_contact_email`/`zitadel_client_id` to `api_keys`, with a partial unique index on `zitadel_client_id` (active/non-revoked keys only). Reuses existing `scopes`/`scopes_format`/`expires_at`/`rotated_from` columns from ADR-008 rather than adding parallel ones — see §I's correction note. | 1     | done                                                                                                                                                                                                                                                                                      | —           |
| T2  | Mint endpoint: validate required fields + Client ID uniqueness (including reclaiming an expired-but-not-yet-revoked key's Client ID, since the partial index alone can't exclude that case) + non-empty `scopes` against known vocabulary, stamp `expires_at` = now + 3mo                                                                                                                       | 1     | done (PR A2, #440)                                                                                                                                                                                                                                                                        | T1          |
| T3  | Revoke endpoint: instant hard-kill, no grace                                                                                                                                                                                                                                                                                                                                                    | 1     | done — no new code needed, `delete.ts`'s existing soft-revoke (ADR-008) already satisfies R2 as-is (confirmed PR A2 session)                                                                                                                                                              | T1          |
| T4  | Rotate endpoint: issue successor, 24h grace on predecessor, cap lineage at 2 (kill any existing dying predecessor instantly before creating a new rotation)                                                                                                                                                                                                                                     | 1     | done (PR A3, #446)                                                                                                                                                                                                                                                                        | T1,T2       |
| T5  | Emergency Rotate endpoint: instant kill of target + its live successor (if any), issue fresh key                                                                                                                                                                                                                                                                                                | 1     | done (PR A3, #446)                                                                                                                                                                                                                                                                        | T4          |
| T6  | Expiry enforcement: auth middleware rejects a key past `expires_at` via the same path as revoked                                                                                                                                                                                                                                                                                                | 2     | done — no new code needed, already implemented in migration 0053 (predates this feature); `resolve_api_key_by_hash()` already filters `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, format-agnostic, already isolation-tested (confirmed 2026-08-21, no PR opened) | T2          |
| T7  | Disconnect/decommission action: instant kill, reuses Revoke's path                                                                                                                                                                                                                                                                                                                              | 2     | done — no new code needed, functionally identical to T3/Revoke per design doc, no distinct trigger/caller specified anywhere (confirmed 2026-08-21, no PR opened)                                                                                                                         | T3          |
| T8  | Key Management UI: list + create form (with Read-only/Read-write presets mapping to `scopes`, plus a custom-scope option) + row actions + amber/red expiry states                                                                                                                                                                                                                               | 2     | in-progress (PR A5, starting)                                                                                                                                                                                                                                                             | T2,T3,T4,T5 |
| T9  | Isolation + unit tests per §R acceptance criteria (revoke timing, rotate 24h boundary, lineage cap, emergency-rotate taint, scopes immutability/vocabulary validation, Client ID uniqueness, expiry boundary)                                                                                                                                                                                   | 3     | todo                                                                                                                                                                                                                                                                                      | T1–T8       |
| T10 | `/security-review`, `/review`, docs marker, commit procedure, PR                                                                                                                                                                                                                                                                                                                                | 3     | todo                                                                                                                                                                                                                                                                                      | T9          |

phase gate: all unit + integration + isolation tests pass before this phase is considered done;
Phase B (`aud` check) depends on T1's `zitadel_client_id` column existing.

## §B Bugs / Backprop Log

| id  | what failed                   | root cause | promoted to §V? |
| --- | ----------------------------- | ---------- | --------------- |
| —   | none yet — pre-implementation | —          | —               |

---

_spec is source of truth — update as decisions are made_
