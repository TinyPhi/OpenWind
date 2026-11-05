# 2026-11-05 — Browser error reporting through the API (#810)

## Decision

`@platform/telemetry` is Node-only (`@sentry/node`, OTel `sdk-node`, server env), and admin-ui had no
browser error sink. Rather than add a second Sentry client with its own copy of the scrubbing rules,
the browser sends to the API, which forwards through the existing `captureException` and its
`beforeSend` scrubber (ADR-015). No DSN reaches the browser and no third-party origin is added.

## Done

- `POST /client-errors` (`apps/api/src/routes/client-errors/`): `requireAuth`, a 16 KiB body cap, a Zod schema with a length cap on every field, the page reduced to its path (no query or fragment), a per-(tenant, user) rate limit of 20/min (`enforceClientErrorRateLimit`, a constant like the erasure limit, fails open), a synthetic `ClientError` passed to `captureException`, `204`.
- `apps/admin-ui/src/lib/report-client-error.ts`: fire-and-forget reporter using plain `fetch` (not `fetchWithAuth`, which raises the global error banner on failure), deduplicated, capped at five per page load, never throws.
- `RouteErrorBoundary.componentDidCatch` reports through it instead of `console.error`.
- Tests: route unit tests (forwarding, path-only, validation, 413, 429, rate-limit key), reporter tests, updated boundary test.

## Security review

`/security-review` (security-reviewer agent): no blocking findings. Two low findings fixed here: the message is collapsed to one line and every browser stack line is prefixed (`browser | `, `component | `, `page | `) so Sentry's frame parser cannot read client text as server frames and merge the event into a real issue group; query strings and fragments inside stack lines are dropped. API keys (`sk_`) get 401 because `requireAuth()` is called without a db.

## Not done

- A global `window.onerror` / `unhandledrejection` handler. The schema's `kind` is an enum with one value so it can grow, but a global handler picks up extension and third-party noise and deserves its own decision.
- No isolation test: the route reads and writes no tenant data. The PR title carries `[skip-isolation-check]`.
- Minified stacks stay minified; source-map upload is a separate piece of work.
- Test gaps: the route test mocks `captureException`, so it does not prove the Sentry scrubber redacts an email in the final event, and it does not exercise the real `requireAuth` rejecting `sk_` or no-token calls.
- ADR-015 does not mention browser errors; a human may want an addendum.
