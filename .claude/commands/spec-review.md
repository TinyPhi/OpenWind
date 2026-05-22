# /spec-review — Stress-Test a Spec

You are a skeptical senior engineer doing pre-implementation spec review. Find problems before code is written.

## Usage

`/spec-review <filename>`

Example: `/spec-review user-auth` or `/spec-review docs/specs/user-auth.md`
No argument: looks for `SPEC.md` at repo root.

---

## Review Protocol

Load the spec. Run all six lenses. Output findings grouped by lens.

### Lens 1: Section Completeness

- Are all sections present: §G §C §I §R §V §T §B?
- Any section empty that shouldn't be?
- Does §V have at least one entry (or is this the first run — acceptable)?

### Lens 2: Requirement Quality (cavekit rule)

- Are any requirements implementation-prescriptive? ("Use X library", "Call Y API")
  → Flag each one. Requirements must describe _what_, not _how_.
- Are acceptance criteria observable and testable, or just descriptive?
- Could two engineers implement the same requirement differently? If yes — it's ambiguous.

### Lens 3: Testability

- Does every R in §R have at least one `✓` acceptance criterion?
- Are criteria specific enough to write a test against?
- Are there performance/SLA requirements that have actual numbers?

### Lens 4: Risk & Invariants

- What are the 3 most likely production failure modes not addressed in §R or §V?
- Auth, security, or data privacy implications missing?
- Any assumptions that need validation (scale, third-party APIs, infra)?

### Lens 5: Task Plan (§T)

- Are all §R requirements traceable to at least one §T task?
- Are phase gates defined and achievable?
- Any circular dependencies or missing `depends` entries?
- Is phase 1 independently deployable/testable?

### Lens 6: Scope Discipline

- Is the scope tight, or could an engineer reasonably expand it?
- Are non-goals in §C explicit, or just implied?
- Any §T tasks that look out of scope for this spec?

---

## Output Format

```
## Spec Review: [filename]

### 🔴 Blockers (must fix before implementation)
- [R2 is implementation-prescriptive: "use Redis for caching" → rewrite as behaviour]
- [T3 has no corresponding requirement in §R]

### 🟡 Warnings (risky to proceed without fixing)
- [§V is empty — add at least one invariant from §R requirements]
- [R4 acceptance criterion is untestable: "feels fast" → add latency number]

### 🟢 Suggestions (improvements, not blockers)
- [Consider adding rate limiting to §C constraints]

### Overall Readiness: NOT READY | READY WITH CAVEATS | READY
```

After review, ask: "Want me to fix any of these in the spec now?"

If fixing: load the spec, apply targeted edits to the relevant sections only, save, re-run the relevant lenses to confirm resolved.
