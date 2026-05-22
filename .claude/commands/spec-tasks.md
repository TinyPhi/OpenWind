# /spec-tasks — Generate Implementation Plan from Spec

You are a technical lead breaking a reviewed spec into a concrete, phase-gated implementation plan for Claude Code agents.

## Usage

`/spec-tasks <filename>`

No argument: uses `SPEC.md` at repo root.

---

## Protocol

1. Load the spec file
2. Check that `§R` and `§T` sections exist — if `§T` is empty, generate it first
3. Expand `§T` into a full phase plan (see OUTPUT FORMAT)
4. Update the `§T` table in the spec file with any new/refined tasks
5. Save the expanded plan to `docs/specs/<filename>-tasks.md`
6. Print the kick-off prompt

---

## Task Generation Rules (from §R)

Every requirement in `§R` must map to at least one task in `§T`. If tasks are missing:

- Create them
- Assign to the earliest phase where dependencies allow
- Add to the `§T` table in the spec

Phase assignment logic:

- **Phase 1**: Data models, core domain logic, no external dependencies
- **Phase 2**: Service/API layer, integrations, internal interfaces from §I
- **Phase 3**: Consumer-facing layer (UI, webhooks, events), end-to-end flows
- Max 4 phases — if more needed, the spec should be split

---

## OUTPUT FORMAT

```markdown
# Implementation Plan: [Feature Name]

**Spec:** [spec filepath]
**Generated:** YYYY-MM-DD
**Status:** not started

---

## Phase 1 — [Name, e.g. "Core Domain"]

**Goal:** [one sentence]
**Gate:** all unit tests pass → then Phase 2

| task       | requirement | status |
| ---------- | ----------- | ------ |
| T1: [task] | R1          | todo   |
| T2: [task] | R1, R2      | todo   |

---

## Phase 2 — [Name, e.g. "API Layer"]

**Goal:**
**Gate:** integration tests pass + Phase 1 gate still green

| task | requirement | status |
| ---- | ----------- | ------ |
| T3:  | R3          | todo   |

---

## Phase 3 — [Name, e.g. "Consumer Integration"]

**Goal:**
**Gate:** §R acceptance criteria met

| task | requirement | status |
| ---- | ----------- | ------ |
| T4:  | R4          | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:
```

Read [spec filepath] and [tasks filepath].

Implement Phase 1 tasks only (T1, T2).

Rules:

- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant

```

```

---

## Backprop Reminder

After any implementation session, remind the developer:

- "If any tests failed during this phase, run `/spec amend §B` to log them."
- "If a pattern emerged that shouldn't repeat, run `/spec amend §V` to lock it in as an invariant."

This is how the spec stays alive and gets smarter over time.
