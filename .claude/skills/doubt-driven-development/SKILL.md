---
name: doubt-driven-development
description: Subjects a non-trivial decision to adversarial review before it stands. Invoke for branching logic, a change crossing a service/security/data boundary, or correctness that can't be directly verified (thread safety, idempotency, RLS enforcement, lock ordering) — skip for mechanical operations like renaming or formatting.
---

# Skill: doubt-driven-development

Subjects non-trivial decisions to adversarial review before they stand.
"A confident answer is not a correct one."

---

## When to use

Invoke `/doubt` when:

- A decision introduces branching logic or crosses a service boundary
- Correctness depends on something you cannot directly verify (thread safety,
  idempotency, RLS enforcement, lock ordering)
- The change is irreversible or touches a security/data boundary
- You are about to commit a fix to any hardening issue (#120–#129)

Skip for mechanical operations: renaming, formatting, config value changes.

---

## Process

### 1. CLAIM — name the decision

State in 2–3 lines:

- What you are doing
- What correctness means here
- What breaks if you are wrong

### 2. EXTRACT — isolate the artifact

Pull out only the code/SQL/config being decided on.
Do NOT include your reasoning — pass artifact + contract only.

### 3. DOUBT — adversarial review

Invoke a fresh-context subagent with:

```
Here is an artifact and its contract. Your job is to find flaws.
Do not validate — actively try to break it.

Contract: [paste contract]
Artifact: [paste artifact]

Find: incorrect assumptions, missing edge cases, ways the contract is violated.
```

Withhold your original claim entirely. If you hand over conclusions,
you get back validation of your conclusions.

### 4. RECONCILE — classify findings

For each finding from the reviewer:

- **Contract misread** — reviewer misunderstood the invariant → clarify and re-run
- **Actionable** → fix before committing
- **Trade-off** → document in a comment or BLOCKERS.md, proceed
- **Noise** → discard

### 5. STOP

Stop when: all findings are trade-offs or noise, OR 3 cycles complete, OR explicitly
told to ship.

---

## Cross-model escalation

In interactive sessions, offer the user a choice between single-model and cross-model
review for the highest-stakes decisions (RLS changes, auth changes, schema migrations).

---

## OpenWind defaults

Run `/doubt` before committing any fix to:

- `withTenantContext` / RLS policies (tenant isolation)
- `workflow_events` writes (append-only invariant)
- `automation_rules` execution logic (recursion cap, circuit breaker)
- Auth middleware (session handling, role claims)
