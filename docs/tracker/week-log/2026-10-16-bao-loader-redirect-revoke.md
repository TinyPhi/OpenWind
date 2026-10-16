# 2026-10-16 — OpenBao loader redirect and token-revoke fixes

**Session type:** Review follow-ups
**Branch:** `fix/PLAT-hardening-bao-loader-redirect-revoke`
**Issues:** #962, #963 (R3 findings on #938)

- **Done.** Both loaders (`bao-env-loader.mjs`, `bao-env-loader.py`) no longer follow redirects: any 3xx on the
  login or KV read exits 77 with a clear message and is not retried. The token is now revoked in a `finally`
  around the KV read, so an unreachable or refused read no longer leaves it live. In the Python loader `fail()` now
  raises a `Fatal` and the pause and exit happen at the entry point, so the revoke runs before the failure pause
  (it used to sleep first), and the revoke catches any exception so it can't replace the exit code.
- **Decision.** #962 suggested `redirect: "error"`. That throws, which the retry loop reads as a transient
  network failure: up to `BAO_WAIT_SECONDS` of retries and a misleading "unreachable" exit. The loaders use
  `redirect: "manual"` (Node) and a no-redirect handler (Python) and refuse the 3xx explicitly instead.
- **Verified.** Loader tests against the fake HTTPS server, both loaders: a redirect on login and on the KV read
  never reaches the target path; the token is revoked when the read stays unavailable until the deadline. Six of
  those tests failed before the change.
- **Deferred.** When OpenBao accepts connections but hangs, the final revoke can add up to the 15 s request
  timeout before the loader exits 69.
- **Review.** Security review (read-only, code reading): no blocking findings. Two low findings fixed here, with
  tests that fail before the change (revoke after the 30 s pause; exit code replaced when the revoke answers
  with a non-JSON body). Not changed: Python still honours `HTTPS_PROXY` through the default `ProxyHandler`
  (as before this change; Node ignores it), so the CIDR check covers direct DNS only. `ProxyHandler({})` would
  close that, but it could break a deployment that relies on a proxy, so it needs a decision.
