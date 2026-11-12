## 2026-11-02 — login link and branding, raised for review

**Session type:** re-landing work built earlier on a long-lived branch, as one PR from current `main`
**Spec:** [multi-org-sandbox](../../specs/multi-org-sandbox.md) R13, T41 onward.

The work is the three earlier entries (2026-10-26 login-org-branding, 2026-10-27 login-key, 2026-10-28
login-blank-fallback and session-and-login-link) taken together; nothing in the design changed.

| State                                   | Event                             | Outcome                                                                        | Kind       | Evidence                              |
| --------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ | ---------- | ------------------------------------- |
| Sandbox has a login key                 | Anyone opens `/login?org=<key>`   | Login card shows that organisation's name and logo                             | introduced | `public-org-branding` isolation test  |
| Key matches nothing                     | Anyone opens `/login?org=<key>`   | Plain login page, no brand, nothing says whether a real organisation exists    | introduced | `login.test.tsx`, isolation test      |
| Person signed in through their own link | Sign-out, idle logout, expiry     | Sent back to `/login?org=<key>`; key checked as 16 hex on every read and write | introduced | `login-org.test.ts`, `login.test.tsx` |
| Platform admin                          | Opens the sandbox list or details | Sees and copies the login link                                                 | introduced | platform-admin page tests             |

**Notes**

- Migrations are 0161 (`platform_admin` slug grant, revoked again by 0162) and 0162 (`tenants.login_key`). They were
  0156 and 0157 on the old branch; main took those numbers, then 0158 to 0160, so they were renumbered with
  journal timestamps later than 0160's.
- New admin-ui strings on the sandbox pages (login link labels) are plain English, like the other new strings
  added since the translation work; moving them to the locale files is a follow-up.
- Security review (2026-11-02): no blocking findings. A bad, unknown, real-tenant or inactive key all return the same
  404; a real tenant can never hold a key (CHECK); only name and logo are returned, and the logo must be a raster data
  URL. `analytics_user` cannot read `login_key`. Low and accepted: the per-IP limiter fails open if Redis is down, like
  every other tier (a 60-bit key is still infeasible to guess), and its client address depends on `TRUST_PROXY` being
  set correctly in production.
