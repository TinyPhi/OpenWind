---
paths: ["**/*.test.ts", "**/*.spec.ts", "tests/**"]
---

# Testing Conventions — OpenWind Platform

---

## Coverage requirement

Every PR that adds or changes behavior must include tests. CI blocks merge if coverage drops.

---

## File layout

```
packages/workflow-engine/src/
  engine.ts
  engine.test.ts       # unit tests colocated with source

tests/
  integration/         # cross-package integration tests
  isolation/           # tenant RLS isolation tests — run on every db/ PR
  e2e/                 # full API end-to-end tests
```

---

## Test naming — behavior, not implementation

```typescript
describe('executeTransition', () => {
  it('transitions entity to new state when all guards pass', ...);
  it('throws TRANSITION_FORBIDDEN when actor lacks required role', ...);
  it('throws CONDITION_NOT_MET when condition evaluates false', ...);
  it('writes immutable event log entry on successful transition', ...);
  it('rolls back all writes if outbox insert fails', ...);
});
```

Descriptions are complete sentences. "transitions entity to new state" — not "calls db.update".

---

## Test isolation

Each suite gets a fresh schema via `packages/db/test-utils` which creates a test tenant,
runs all migrations, and tears down after the suite. Tests never share state.

External service calls are mocked at the **service boundary** — not at the DB layer.
Never mock the database itself (mock/prod divergence has caused production incidents).

---

## Isolation test suite mandate

`tests/isolation/` is mandatory reading before touching any database code. It attempts
cross-tenant data access via every public API surface.

**Adding a new route or table? Add isolation tests in the same PR.**

Run: `pnpm test:isolation` (requires Docker/OrbStack stack up).

---

## Prove-It Pattern — use for every bug fix

When fixing a bug, write the reproduction test _first_, before touching any source code:

```
1. Write a test that reproduces the exact failure (it MUST fail on current code)
2. Fix the bug
3. Confirm the test now passes
4. Commit test + fix together
```

Never fix a bug without a failing test first. "It seems fixed" is not evidence.

---

## Test double preference

Prefer in this order: **real implementation → test database (fresh schema) → fake → stub → mock**.

Mocking the database is prohibited — it was the cause of a production incident where
mocked tests passed but the real migration failed. Mock at service boundaries only
(HTTP calls, external APIs, email/notification delivery).

---

## Task sizing

Keep each test suite to one logical concern. If a test file grows past ~200 lines,
split it. If a PR adds more than one new test suite, reconsider whether the implementation
unit is too large.
