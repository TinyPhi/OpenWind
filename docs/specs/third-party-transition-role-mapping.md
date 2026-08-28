# Third-Party API Transition Role Mapping

> Fix: third-party transition calls pass actorRoles:[], so any transition with allowed_roles
> set is unreachable via the API even when the caller has real ticket-level access.

status: draft
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
| T1  | Change `actorRoles: []` to `actorRoles: ["user"]` in `executeThirdPartyTransitionHandler`, only for the request built AFTER `hasTransitionAccess` has already returned true | 1     | todo   | —       |
| T2  | Correct the stale doc comment claiming acting persons have no role                                                                                                          | 1     | todo   | T1      |
| T3  | Unit/isolation test: transition with `allowed_roles: {"user"}` succeeds for creator/assignee/workflow-admin acting person                                                   | 1     | todo   | T1      |
| T4  | Unit/isolation test: transition with `allowed_roles: {"admin"}` (no `"user"`) still 403s for a third-party caller                                                           | 1     | todo   | T1      |

phase gate: all unit + isolation tests pass

---

## §B Bugs / Backprop Log

| id  | what failed                                                    | root cause                                                                | promoted to §V? |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------- |
| B1  | Third-party transition calls 403 on every real seeded workflow | `actorRoles: []` hardcoded, never satisfies any non-empty `allowed_roles` | yes — see §V    |

---

_spec is source of truth — update as decisions are made_
