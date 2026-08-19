---
name: api-and-interface-design
description: Guides stable API and interface design — contract-first, versioning, and Hyrum's-Law-aware. Invoke when designing a new Hono route, a public/partner-facing API surface (ADR-010), a tRPC procedure, or a module boundary contract, especially before Stage 3's public API versioning scheme has a shape.
---

# Skill: api-and-interface-design

Design interfaces that are hard to misuse. Every observable behavior of a shipped API —
not just what's documented — becomes a de facto contract once something depends on it
(Hyrum's Law). That cost is highest at OpenWind on two surfaces: Hono routes consumed by
`admin-ui`, and anything that will become part of ADR-010's Tier 1 partner-facing API.

---

## When to use

Invoke when:

- Designing a new Hono route or changing an existing one's response shape
- Scoping ADR-010's Stage 3 public API versioning scheme (do this _before_ the first
  Tier-1 partner key ships, not after — retrofitting a version scheme onto a live partner
  integration is a migration, see `deprecation-and-migration`)
- Defining a new tRPC procedure or cross-module contract (event bus payload, entity
  relations API call)
- Adding fields to an existing response envelope, or changing an existing field's meaning

Skip for internal-only helper functions with a single caller.

---

## Core principles

**Contract first.** Write the Zod schema (per `code-style.md`, types derive from Zod, never
the reverse) before the handler body. The schema _is_ the spec.

**Hyrum's Law discipline.** Don't leak implementation details a caller could come to depend
on: no raw DB row shapes in responses, no incidental field ordering guarantees, no error
message text treated as a stable value (only the error `code` is a contract — see
`error-handler.ts`'s domain-error mapping).

**One version at a time.** Avoid a route or schema having two live shapes simultaneously
with callers split across them — that's a diamond dependency. Extend fields additively;
when a breaking change is unavoidable, that's a deprecation, not a silent shape change
(hand off to `deprecation-and-migration`).

**Scoped, not implicit, access.** Per ADR-008 Decision #6, the emerging `entity:<type>:<verb>`
action-scope shape is itself an interface — new verbs added to it are a public contract for
every Tier-1 partner key, not an internal enum to churn freely.

---

## OpenWind-specific checklist

- [ ] Response uses the `{ data: T }` / `{ error, message, fields? }` envelope
      (`code-style.md`)
- [ ] Cross-tenant access returns `404`, never `403` (no existence leak)
- [ ] New/changed fields are additive where possible; breaking shape changes get a version
      boundary, not an in-place mutation
- [ ] For anything reachable from ADR-010's partner surface: does this need to exist in a
      versioned `/v1/...` path from day one, since retrofitting versioning after a partner
      is live is materially harder than shipping it from the start?
- [ ] Scopes/verbs referenced are the confirmed OQ-5 set, not an ad hoc string

---

## Flag, don't guess

If a route's contract is ambiguous (should this field be nullable? what does absence vs.
`null` mean?), state the ambiguity and the chosen interpretation rather than picking
silently — an API contract mistake is expensive to unwind once a caller depends on it.
