# 2026-10-14 — step-up MFA for sandbox reset and delete (#865, #800, #801)

**Session type:** Code
**Branch:** `fix/PLAT-865-sandbox-step-up-mfa`

- ADR-022 Decision 10 accepts a 12-hour MFA window on the strength of two compensating controls. The first, a fresh code before every reset or delete, was documented as "tracked as part of T22" but T22 shipped only as the per-sandbox lock, so the routes used `requirePlatformAdmin()` alone. This builds it. Owner decisions: implement it, a 5-minute window, resend plus a documented break-glass.
- A successful `/mfa/verify` also sets a per-admin Redis marker lasting `PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS`. `requireFreshMfa()` sits after `requirePlatformAdmin()` on the reset and delete routes only, answers `403 MFA_REAUTH_REQUIRED`, honours the dev-only bypass, and fails closed on a Redis error. Verified against the real Redis: `SET … EX … NX` claims once and then returns null, and the marker expires.
- Both new timings are validated config (`PLATFORM_ADMIN_MFA_FRESH_WINDOW_SECONDS` 60–900, `PLATFORM_ADMIN_MFA_RESEND_COOLDOWN_SECONDS` 5–300), not constants. The bounds stop the step-up being switched off or stretched back into the long window. Tests mock unusual values (120 and 7) so a hardcoded number would fail them.
- #801: `/mfa/request` enforces a per-admin resend cooldown and answers `429` with `Retry-After`; it also returns `resendAfterSeconds` so the dialog's countdown comes from the server's setting. The OTP-failure and break-glass procedure is in spec §O.
- admin-ui: `fetchWithAuth` errors now carry the server `code`; reset and delete open a code dialog on `MFA_REAUTH_REQUIRED` and retry once verified. A second `MFA_REAUTH_REQUIRED` straight after verifying is shown as an alert instead of looping.
- Still hardcoded (unchanged): the 12-hour verified window, the 10-minute code lifetime and the 5-attempt cap. Moving them to config is a possible follow-up.
- Not in this change: the ADR-022 text itself (Decision 9 line 188, Decision 10 control 1, and a new paragraph for #801), which a human edits.
