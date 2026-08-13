---
name: idea-refine
description: Transforms a vague concept into a sharp, actionable direction with explicit trade-offs. Invoke when an idea is too vague to spec, before committing to a direction that needs assumptions stress-tested, or when starting Phase 3B/3C design work that has no ADR yet.
---

# Skill: idea-refine

Transform a vague concept into a sharp, actionable direction with explicit trade-offs.
Simplicity is the ultimate sophistication. Say no to 1,000 things — focus beats breadth.

---

## When to use

Invoke `/refine` when:

- An idea is too vague to spec ("we need better integrations", "the workflow should be smarter")
- You need to stress-test assumptions before committing to a direction
- Starting Phase 3B (plugin system) or 3C (AI layer) design — before any ADR (3A's ADRs,
  ADR-008/009/010, are accepted; this trigger is for tracks that don't have one yet)
- The user says "I'm not sure exactly what I want but..."

---

## Process

### Phase 1 — Diverge (understand and expand)

**Restate** the idea as a "How Might We" question:

> "HMW: How might we let tenants connect third-party tools without writing custom code?"

**Ask sharpening questions** (one at a time, with your guess):

- Who specifically is the user? (not "tenants" — which role?)
- What are they doing today instead? (the workaround reveals the real pain)
- What does success look like in 3 months?
- What would make this a failure?

**Generate 5–8 variations** using lenses:

- Inversion: what if we made it _harder_ to connect?
- Constraint removal: what if there were no rate limits?
- Simplification: what's the 10-line version of this?
- 10x version: what if this handled 10,000 connectors?
- User-first: what does the tenant admin see on day one?

### Phase 2 — Converge (evaluate and stress-test)

Cluster the variations into 2–3 distinct directions.

For each direction, pressure-test against:

- **User value** — does this solve the actual problem or a proxy?
- **Feasibility** — can we build this in Phase 3A scope?
- **Differentiation** — does this make the platform meaningfully better?

Surface the hidden assumptions that could make each direction fail.
Name them explicitly — an assumption is a risk until validated.

### Phase 3 — Output (sharpen and ship)

Produce a one-pager saved to `docs/ideas/[idea-name].md`:

```markdown
## Problem statement

[one sentence — specific, not generic]

## Recommended direction

[the one direction to pursue, and why]

## Key assumptions to validate

- [assumption 1 — how to test it]
- [assumption 2 — how to test it]

## MVP scope

[minimum that proves the direction — 3-5 bullet points]

## Not doing

[what we are explicitly ruling out — this list is as important as the MVP]
```

The "Not Doing" list is the most valuable part. Make trade-offs visible before
they become implicit scope creep.

---

## After `/refine`

Feed the output into `/interview` to confirm with the user, then `/spec` to
write the implementation spec. The one-pager replaces a vague Slack message
as the source of truth for the feature.
