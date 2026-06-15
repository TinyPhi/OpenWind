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
