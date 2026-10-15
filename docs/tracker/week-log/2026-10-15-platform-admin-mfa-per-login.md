# 2026-10-15 — platform-admin MFA on every sign-in, and a reworked code screen

**Session type:** Owner decision after testing platform-admin 2FA locally
**Branch:** `feat/platform-admin-mfa-per-login`

- **What testing showed.** With the dev bypass off, the code email arrived and verified. But
  the verified marker was keyed by the user id alone, for 12 hours. Signing out and back in, or
  signing in from another browser or device, skipped the code entirely. The owner chose a code
  on every platform-admin sign-in.
- **Per-sign-in verification.** A correct code now returns a random MFA session token. The
  verified marker (still at most 12 hours) and the step-up "fresh" marker are keyed by the user
  id plus the token's sha256, never the token itself. `requirePlatformAdmin` and
  `requireFreshMfa` read it from `X-Platform-Admin-Mfa`; a request without it is never verified.
  - admin-ui stores the token beside the OIDC user and sends it only to `/api/platform-admin/*`.
  - It is dropped on every completed sign-in (`/auth/callback`) and on sign-out.
  - Sign-out first calls the new `POST /platform-admin/mfa/end`, best effort.
  - A step-up code replaces the session's token.
- **Code screen.** The sign-in page and the reset/delete step-up dialog now share one flow:
  - "We sent a 6-digit code to t\*\*\*@gmail.com", from a masked address the API returns;
  - six digit boxes: typing advances, Backspace goes back, a pasted or autofilled code is
    spread across them, and it submits on the sixth digit;
  - a countdown to the code's 10-minute expiry, and the resend cooldown on the button;
  - separate messages for a wrong code (with attempts left), an expired code and too many
    attempts; the last two lock the boxes until a new code is sent;
  - a Sign out link on the page, for the wrong account or an inbox you can't reach.
- **Bugs fixed on the way.**
  - A wrong code was answered `401`. The client refreshes and replays any `401`, so one wrong
    guess used two of the five attempts. Wrong-code answers are now `422`.
  - `PLATFORM_ADMIN_MFA_DEV_BYPASS=false` turned the bypass **on**, because
    `z.coerce.boolean()` reads every non-empty string as true. Only the literal `true` enables
    it now, like `SKIP_AV_SCAN`.
  - The code-sent log line now carries the masked recipient, so a send can be traced.
- **ADR.** ADR-022 Decision 10 records a 12-hour window keyed per user id. This change narrows
  it to one sign-in. A human amendment to the ADR is logged in BLOCKERS.md.
- **Tests.** Core MFA (per-session keys, token never stored, step-up replacement, expired /
  invalid with attempts left / locked, masked log), middleware (header read, missing header),
  routes (token returned, 422 mapping, `/mfa/end`), config (`false`, `0`, empty, `TRUE` stay
  off; production refusal), and admin-ui (digit boxes, paste, backspace, countdowns, resend,
  each error, header sent only to platform-admin routes, cleared on sign-in, sign-out order).

## Also in this PR: tenant login page polish

- **Contact link.** The `/login` help link ("Need access? Contact us", previously "Contact
  your admin" pointing at `mailto:support@openwind.io`) opens a Gmail compose window in a new
  tab, addressed to info@rokkalabs.com with a product-trial request already filled in (subject,
  greeting, and blanks for name, company, role, team size, phone and use case). The address and
  template live in one module, `apps/admin-ui/src/pages/login-contact.ts`. It's Gmail rather
  than `mailto:` by request, so a visitor who isn't signed in to Gmail lands on Google's sign-in.
- **Logo.** The placeholder "W" box is replaced by the navbar's own logo (`/favicon.svg` and the
  "OpenWind" wordmark, same classes), so the two always match; on phones only the icon shows,
  as in the navbar.
- **Flat card.** The sign-in card's large drop shadow is removed; its border frames it.
- **Footer removed.** The "© 2026 OpenWind · GitHub · Docs · Privacy" bar (Docs and Privacy were
  dead `#` links) is gone, with its CSS and strings.
- **Sandbox handover CSV.** The platform-admin handover dialog (already reviewed, held back
  while #926 was open) is included: a Download CSV button and a wider dialog.
