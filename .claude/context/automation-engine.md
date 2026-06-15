# Automation Engine — Context Guide

Load this when working in `packages/automation-engine/`, touching automation rules,
the outbox poller, circuit breaker, SSRF guard, or action dispatch.

---

## What it does

Event-driven rule executor. When the outbox poller delivers an event, `executeAutomationRules()`
loads all enabled rules matching the trigger type, evaluates their condition trees, and
runs their action lists inside savepoints. Circuit breaker and recursion guard prevent
runaway execution.

---

## Key functions

| Function                                   | Purpose                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `executeAutomationRules()`                 | Main entry: match rules → evaluate conditions → run actions        |
| `createAutomationRule()` / CRUD            | Manage rule definitions                                            |
| `isOpen()` / `recordFailure()` / `reset()` | Circuit breaker state (Redis-backed, per action per tenant)        |
| `validateWebhookUrl()`                     | SSRF guard — DNS resolve + CIDR blocklist check, returns pinned IP |

---

## Invariants that will surprise you

**Recursion depth cap of 10.** If an action fires an event that matches another rule (cascade),
depth is incremented. At depth 10, `MAX_DEPTH_EXCEEDED` is thrown and the chain stops.
Prevents infinite automation loops.

**Actions run sequentially inside a savepoint.** If action 0 fails, all subsequent actions
are skipped and the savepoint rolls back. No partial execution within a single rule.

**Circuit breaker is simple open/closed — no half-open.** When the Redis TTL on the failure
counter expires, the circuit resets cold. Default threshold: 5 failures. A webhook SSRF
block counts as a failure.

**Circuit breaker is per-action per-tenant.** A webhook action failure for Tenant A doesn't
affect Tenant B, and doesn't open the circuit for `set_field` actions in the same tenant.

**Execution status can be `degraded`** if some actions were skipped by the circuit breaker
(others succeeded). The `result` field contains `{ skippedActions: N }`.

**SSRF validation is fail-safe.** DNS timeout (2s), DNS error, malformed URL, or any resolved
IP in blocked CIDR ranges → the webhook is blocked. The pinned IP is returned for TCP
connection to prevent DNS rebinding after validation.

---

## Tables owned / read

Owned: `automation_rules`, `automation_executions`

Reads: `outbox_events` (trigger source), `entity_instances` (event payload + field values)

---

## Errors

`AutomationError` codes: `RULE_NOT_FOUND`, `RULE_CREATE_FAILED`, `MAX_DEPTH_EXCEEDED`,
`ACTION_FAILED`, `INVALID_EVENT_PAYLOAD`, `WEBHOOK_SSRF_BLOCKED`, `DNS_RESOLUTION_TIMEOUT`.

---

## Gotchas

- Condition trees can reference **both** top-level event properties (`toState`, `fromState`)
  and entity field values. For `entity.created` events, the `fields` map is merged in.
  For other events, only top-level properties are available.
- The trigger event Zod schema is validated **before** rules are loaded. Malformed events
  throw `INVALID_EVENT_PAYLOAD` immediately — rules never run.
- Dead-letter events: events that fail after the 48-hour stale threshold go to a DLQ table.
  Operators can inspect and manually re-trigger or discard from the admin UI.
- Issue #2 (SSRF + PII leakage gaps) is a known open item and a **pilot blocker**. Do not
  modify `validateWebhookUrl()` or PII handling without human review.
