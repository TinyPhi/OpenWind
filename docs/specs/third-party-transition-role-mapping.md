# Third-Party API Transition Role Mapping

> Fix: third-party transition calls pass actorRoles:[], so any transition with allowed_roles
> set is unreachable via the API even when the caller has real ticket-level access.

status: implemented
created: 2026-08-28
updated: 2026-08-28

---

## §G Goal

A third-party caller who already has legitimate ticket-level transition access (creator,
assignee, or workflow-admin, per `hasTransitionAccess`) can execute any transition whose
`allowed_roles` includes the platform's baseline `"user"` role — i.e., every transition a
regular internal user could run. No change to transitions restricted to `"admin"`/`"agent"`
only — those stay out of API reach, same as today.

---

## §C Constraints

| constraint   | value                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| stack        | apps/api (Hono), packages/workflow-engine                                                |
| auth         | ADR-012 dual-identity (API key + acting-person token) — no change to that auth model     |
| out of scope | ADR-006's `__accessUsers` gap (unrelated, already-accepted v1 limitation); RBAC redesign |
| out of scope | Any change to `allowed_roles` semantics for internal (human) callers                     |
| out of scope | `"admin"`/`"agent"`-only transitions — still unreachable via the third-party API         |

**Note on ADR-006 interaction (review F-05):** this fix does not change ADR-006's accepted v1
gap itself (transition guards still don't consult per-instance `__accessUsers` grants), but it
does change who reaches the gap. Before this fix, a `"user"`-role-restricted transition was
unreachable via the API for anyone, so the gap was moot for that population. After this fix,
every creator/assignee/workflow-admin caller reaches it — a larger population than before, for
whom a workflow admin cannot yet use `__accessUsers` to restrict a `"user"`-role transition to a
subset. This is an expansion of the gap's _reach_, not a new vulnerability or a change to the
gap's own severity — it remains the same accepted v1 limitation ADR-006 already documents.

---

## §I Interfaces

`executeThirdPartyTransitionHandler` (`apps/api/src/routes/third-party/transitions.ts`)
builds a `TransitionRequest` and calls `executeTransition(tx, tenantId, request)`
(`packages/workflow-engine/src/engine.ts`). The engine's own guard:

```
if (transition.allowedRoles.length > 0 && !hasRequiredRole(actorRoles, transition.allowedRoles))
  throw TRANSITION_FORBIDDEN
```

Today `request.actorRoles` is hardcoded `[]` for every third-party transition call. This
spec changes only that one value at the call site — the engine's guard logic itself is
unchanged.

---

## §R Requirements

R1: A third-party transition call from a caller who already passed `hasTransitionAccess`
(creator, assignee, or workflow-admin) is treated as holding the platform's baseline
`"user"` role for the purposes of the transition's `allowed_roles` check.
✓ Executing a transition whose `allowed_roles` includes `"user"` succeeds (201) for a
creator/assignee/workflow-admin caller, where today it returns 403.
✓ Executing a transition whose `allowed_roles` is `{"admin"}` or `{"agent"}` only (no
`"user"`) still returns 403/`TRANSITION_FORBIDDEN` for a third-party caller — this
requirement does not grant elevated roles, only the baseline one.
✓ A caller who does NOT pass `hasTransitionAccess` still gets 404 before this role check
is ever reached — unchanged.

R2: The role mapping applies only to the transition-execution path, not to any other
third-party route's authorization.
✓ No other third-party route (`tickets`, `comments`, `children`, `attachments-*`) changes
behavior as a result of this fix.

R3: The fix is visible in the module's own documentation, since the existing code comment
explicitly claims "the acting person has no internal RBAC role in this system" — that
comment becomes inaccurate and must be corrected, not left contradicting the code.
✓ `transitions.ts`'s doc comment no longer claims `actorRoles: []` is required by acting
persons having no role; it explains the baseline-`"user"` mapping and why.

---

## §V Invariants

- A third-party transition call NEVER succeeds unless `hasTransitionAccess` already passed
  (creator/assignee/workflow-admin) — the role mapping is additive to that gate, never a
  substitute for it.
- The synthetic role granted is always exactly `{"user"}` — never `"admin"`/`"agent"`, and
  never derived from any claim in the acting-person JWT (which carries no OpenWind RBAC
  role at all; it's an external identity token).

---

## §T Tasks

| id  | task                                                                                                                                                                        | phase | status | depends |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Change `actorRoles: []` to `actorRoles: ["user"]` in `executeThirdPartyTransitionHandler`, only for the request built AFTER `hasTransitionAccess` has already returned true | 1     | done   | —       |
| T2  | Correct the stale doc comment claiming acting persons have no role                                                                                                          | 1     | done   | T1      |
| T3  | Unit/isolation test: transition with `allowed_roles: {"user"}` succeeds for creator/assignee/workflow-admin acting person                                                   | 1     | done   | T1      |
| T4  | Unit/isolation test: transition with `allowed_roles: {"admin"}` (no `"user"`) still 403s for a third-party caller                                                           | 1     | done   | T1      |
| T5  | Review follow-up (F-01): add assignee + workflow-admin isolation test cases for the `allowed_roles: {"user"}` transition, not just creator                                  | 1     | done   | T3      |
| T6  | Review follow-up (F-03/S-01): named, `as const`-typed constant for the granted role instead of an inline string literal                                                     | 1     | done   | T1      |
| T7  | Review follow-up (F-04): distinct `toState` values for the two role-mapping fixtures, avoiding a duplicate `(fromState, toState)` pair on one workflow                      | 1     | done   | T3      |

phase gate: all unit + isolation tests pass

---

## §B Bugs / Backprop Log

| id  | what failed                                                    | root cause                                                                | promoted to §V? |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------- |
| B1  | Third-party transition calls 403 on every real seeded workflow | `actorRoles: []` hardcoded, never satisfies any non-empty `allowed_roles` | yes — see §V    |

**PR #514 principal-engineer review (PrabhuVijit) — addressed:**

| id   | finding                                                                                 | resolution                                                                                                 |
| ---- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| F-01 | Isolation tests only covered the creator path, not assignee/workflow-admin              | Added two isolation tests (assignee, workflow-admin) against the same `allowed_roles: {"user"}` transition |
| F-02 | Spec shipped with `status: draft` and all §T tasks `todo` despite a live implementation | `status: implemented`; T1–T4 marked `done`; T5–T7 added for this review's own follow-ups                   |
| F-03 | No mechanical guard against a future accidental role-elevation edit                     | `THIRD_PARTY_BASELINE_ACTOR_ROLES = ["user"] as const` in `transitions.ts`, used at the one call site      |
| F-04 | Two role-mapping fixtures shared the same `(open, processing)` state pair               | Renamed to distinct `toState`s (`processing_user_role`, `processing_admin_only`)                           |
| F-05 | ADR-006 gap's interaction with this fix wasn't explained in §C                          | Added a note under §C explaining the gap's reach changed, not its severity                                 |
| S-01 | `"user"` role string was a bare literal with no named reference                         | Same constant as F-03 (workflow-engine has no exported role-name constants to reference instead)           |

---

_spec is source of truth — update as decisions are made_
