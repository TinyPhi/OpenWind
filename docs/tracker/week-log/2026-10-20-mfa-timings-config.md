# 2026-10-20 — #929 platform-admin MFA timings to config

- Moved `VERIFIED_TTL_SECONDS`, `OTP_TTL_SECONDS` (`MFA_CODE_TTL_SECONDS`) and `MAX_VERIFY_ATTEMPTS` in
  `packages/auth/src/platform-admin-mfa.ts` to validated env vars, same pattern as #925. Defaults are the
  old values (43200 / 600 / 5).
- Bounds: verified 900–86400, code 60–1800, attempts 1–10; refine: code lifetime <= verified lifetime.
- Email body renders `ceil(seconds / 60)` minutes. `MFA_CODE_TTL_SECONDS` export removed; the
  `/mfa/request` route reads the env var for `expiresInSeconds`.
- Tests: env defaults/accept/reject/cross-field; auth unit tests for each value.
- ADR-022 Decision 10 still calls the 12h value fixed; a human should note it is now configurable.
- `/security-review` is still pending (run by the orchestrator).
