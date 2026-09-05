# Third-Party API Origin Tagging

> Tickets/comments created via the 3rd-party API or the hosted handoff flow show who/what
> made them (app + performer) everywhere they appear. Closes ADR-012 design doc §5.1/§5.3
> gap — confirmed unbuilt in admin-ui. For OpenWind agents/admins triaging tickets.

status: draft
created: 2026-09-02
updated: 2026-09-02

---

## §G Goal

Every ticket/comment (incl. sub-tickets) that originates from a 3rd-party integration —
either the direct API (dual-identity, `sk_...` + acting-person token) or the hosted
handoff flow (real OpenWind login, pre-filled by a redirect) — visibly carries a tag
naming the application and the performing person, in every surface where a human would
see the ticket/comment: records list, ticket detail, comment thread, activity/history
timeline. Human-originated content (normal in-app creation) never carries a tag. Creation
is rejected outright — no ticket/comment row is ever created — if the required
app+performer identity can't be resolved.

## §C Constraints

| constraint   | value                                                                                                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack        | `apps/admin-ui` (React/Refine/shadcn) for display; `apps/api` (Hono) for the one required write-path change (persist origin, validate handoff identity)                                                                                                                                                        |
| auth         | Unchanged. Direct API keeps today's dual-identity model (`Authorization: sk_...` + `X-Acting-Person-Token`). Handoff keeps today's real-user OIDC login. This is display + one input-validation gate — no new access-control surface.                                                                          |
| identity ref | Tag's app reference is the **stable per-application identifier** — `api_keys.oidcClientId`, confirmed to persist unchanged across a key's full rotation lineage (`rotate.ts` carries it forward on every rotation). Never `applicationName` (renameable) or `api_keys.id`/`key_hash` (changes every rotation). |
| name display | Application name shown in a tag is resolved **live** at read time from the currently-active `api_keys` row sharing that `oidcClientId` — a rename after the fact updates every existing tag's displayed name; nothing is frozen at creation time.                                                              |
| out of scope | Retroactive tagging of tickets/comments created before this ships. Any change to the handoff flow's ticket _content_ (title/remark prefill contract unchanged). Any new write/API endpoint beyond what persisting-origin/validating-handoff-identity strictly requires.                                        |

## §I Interfaces

**Handoff URL contract** (`docs/specs/hosted-ticket-create-handoff.md`) gains one new
required param carrying the stable app identifier (`oidcClientId` of the initiating
application's registered key). `docs/third-party-api-design.md` and the partner-facing
handoff doc get updated so every 3rd party integrating this flow knows to send it.

**Ticket/comment origin, conceptually** (exact storage shape is a §T task, not decided
here):

```
origin: null                                  // human, in-app — no tag rendered
      | { mechanism: "api",      oidcClientId, performerUserId }
      | { mechanism: "handoff",  oidcClientId, performerUserId }
```

`appName` for display is NOT part of this shape — always resolved live via
`oidcClientId` → current active `api_keys.applicationName`, per §C.

## §R Requirements

R1: A ticket created via the direct 3rd-party API shows the tag `External · [AppName] ·
[PerformerUsername]` in the records list and on the ticket detail page.
✓ List-view row for an API-created ticket renders the tag in this exact format
✓ Detail page renders the same tag
✓ AppName resolves via `oidcClientId`, not a frozen name column

R2: A ticket created via the hosted handoff flow shows the tag `Redirected · [AppName] ·
[PerformerUsername]`.
✓ Same list/detail visibility as R1, label `Redirected` instead of `External`
✓ Handoff URL must carry the app-identifier param to reach the create page
✓ Missing, invalid, or unregistered/revoked app identifier → creation rejected outright,
clear error shown, no ticket row created

R3: Comments created via the direct API show `External · [AppName] · [PerformerUsername]`
inline on that comment. Comments created normally (human, in-app) show no tag.
✓ A ticket with a mix of human and API comments shows the tag only on API-originated ones
✓ Tag renders per-comment, independent of the ticket-level tag

R4: Sub-tickets follow the exact same tagging rules as top-level tickets — own
independent tag, unaffected by the parent ticket's tag state.
✓ A sub-ticket created via API shows its own `External`/`Redirected` tag regardless of
whether its parent ticket has a tag at all

R5: The ticket's activity/history timeline shows the same App+Performer attribution,
in the same format, on every API/handoff-originated entry already logged today (create,
comment, transition, etc.).
✓ A timeline entry for an API action displays the App+Performer inline, matching R1–R3's
tag format

R6: Direct-API ticket/comment creation missing acting-person or application identity is
rejected — proves the existing dual-identity enforcement, not new behavior.
✓ A request missing (or with an invalid) `X-Acting-Person-Token` never creates a
ticket/comment

R7: An app's tag continues resolving correctly — same app, current name — after that
app's key is rotated or its `applicationName` is renamed.
✓ Rotate a key after a ticket is tagged → the tag still resolves to the same application
✓ Rename an app's `applicationName` after tickets are tagged → those tickets' tags now
display the new name (not the name at creation time)

## §V Invariants

- Every 3rd-party-originated ticket/comment/sub-ticket ALWAYS has a non-null, resolvable
  app+performer identity at the moment it's created. Creation is rejected outright — never
  silently created untagged — if either half is missing or unresolvable. This applies
  equally to the direct-API path (pre-existing, via dual-identity) and the handoff path
  (new, via the required app-identifier param).
- Human/in-app-created content NEVER shows a tag.
- A tag's app reference is always the stable per-application identifier
  (`oidcClientId`), never a mutable name string or a rotation-specific key id.

## §T Tasks

**Phase 1 — Data model**
| id | task | phase | status | depends |
|---|---|---|---|---|
| T1 | Confirm `oidcClientId` as the stable per-application anchor (done in spec drafting — verified in `rotate.ts`); document the decision inline where origin is persisted | 1 | done | — |
| T2 | Add origin-tracking to `entity_instances` (tickets, incl. sub-tickets) and comments: `origin_mechanism` (`api`\|`handoff`\|null), `origin_oidc_client_id`, `origin_performer_user_id` — new nullable columns, RLS-consistent with existing tenant-scoped columns | 1 | todo | T1 |
| T3 | Extend the hosted handoff URL contract with a required app-identifier param; server validates it resolves to a real, active, non-revoked `api_keys` row before allowing the create page to submit | 1 | todo | T1 |

**Phase 2 — API surface**
| id | task | phase | status | depends |
|---|---|---|---|---|
| T4 | Third-party ticket-create/comment-create routes (`apps/api/src/routes/third-party/tickets.ts`) persist `origin_mechanism='api'` + `oidcClientId` + acting person id on every write | 2 | todo | T2 |
| T5 | Hosted handoff create-path persists `origin_mechanism='handoff'` + validated `oidcClientId` + the logged-in user's id | 2 | todo | T2, T3 |
| T6 | Read endpoints/queries backing ticket list, ticket detail, comments, and activity timeline expose origin data (app name resolved live via `oidcClientId`, per §C) | 2 | todo | T2 |

**Phase 3 — UI**
| id | task | phase | status | depends |
|---|---|---|---|---|
| T7 | Records-list tag badge (`External`/`Redirected` + app + performer) | 3 | todo | T6 |
| T8 | Ticket-detail page tag (same format) | 3 | todo | T6 |
| T9 | Comment-level tag rendering | 3 | todo | T6 |
| T10 | Activity/history timeline tag rendering | 3 | todo | T6 |
| T11 | Sub-ticket tagging — confirm it falls out of T7/T8 reusing the same component; add explicit isolation test since it's called out as its own priority | 3 | todo | T7, T8 |

**Phase 4 — Enforcement & tests**
| id | task | phase | status | depends |
|---|---|---|---|---|
| T12 | Isolation test: handoff creation with missing/invalid/revoked app identifier is rejected, no ticket row created | 4 | todo | T3, T5 |
| T13 | Regression test: direct-API creation missing acting-person identity is still rejected (R6) | 4 | todo | T4 |
| T14 | Rotation/rename resolution tests: tag continues resolving correctly after key rotation and app rename (R7) | 4 | todo | T4–T10 |

phase gate: all unit + isolation tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed | root cause | promoted to §V? |
| --- | ----------- | ---------- | --------------- |

---

_spec is source of truth — update as decisions are made_
