## 2026-11-01 — 3D: Sentry free-text PII scrubbing (#1149)

### Done

- New shared module `packages/logger/src/redact.ts` (key list, pino paths, text rules, recursive
  scrubber). Home is `@platform/logger` because `telemetry` already depends on it and it has no
  workspace dependencies, so no new package and no dependency-rule change (`pnpm dep:check` clean).
- `packages/telemetry/src/errors.ts` re-uses it: every string in the event goes through `scrubString`
  (email, bearer/basic and JWT tokens, `key=value` secrets); key-based redaction is kept.
- The logger uses the same key list (now one nested level too) and scrubs the message and top-level
  string fields via a pino `logMethod` hook.
- Regexes are length-bounded and strings over 16k chars are truncated (fail closed); nesting past
  64 levels is redacted; tests time hostile inputs.
- Security review triage: key match is now case/dash/underscore-insensitive and covers cookies,
  session, csrf, client_secret; `request.data`, `query_string` and the URL query are dropped; logger
  `err` serializer scrubs message and stack; logger hook copies plain objects only. Medium review: email rule needs an alphabetic TLD (keeps `app@1.2.3`),
  escaped quotes and `Token`/`Digest` schemes handled, logger tests use the real logger options.
  Deferred: full
  nested text scrubbing in logger objects, `child()` bindings, unicode emails.

### Decisions (ADR-015 Decision #2)

- `user.ip_address`: dropped, not hashed (a hashed IPv4 is trivially reversible). Free-text IPs in
  messages are NOT scrubbed: infra addresses (`ECONNREFUSED 10.0.0.5:5432`) are the main diagnostic
  value; a residual risk if a client IP is interpolated into an error message.
- `server_name`: dropped (hostname can identify a developer or container). Use `environment`.
- Source context lines (`pre_context`, `context_line`, `post_context`): dropped. The smoke run showed
  hardcoded literals (an IP, `setExtra("password", "...")`) survive pattern scrubbing in them. Frames
  keep filename, line and function; source is in the repo.
- Residual: key-name false positives such as `max_token=100` are redacted; patterns do not catch
  names, phone numbers or addresses in free text.

### Verification

- pnpm typecheck / lint / dep:check: PASS
- pnpm test: logger 13/13, telemetry 41/41 PASS; other failures are the pre-existing ones
- Bugsink 2.6.2 smoke (throwaway container, 127.0.0.1, removed after): stored event has none of the
  planted email, bearer token, `password=`, IP; the container could not delete the first event, so
  the first run's event (source context still present) coexisted; the second event is clean.
