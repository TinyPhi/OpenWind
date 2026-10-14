# 2026-10-14 — platform-admin login: signed-out and wrong-account states

**Session type:** Fix found in manual testing
**Spec:** `docs/specs/multi-org-sandbox.md` T17
**Branch:** `fix/platform-admin-login-session`

- **Signed-out visitors saw "Not authorized".** `/platform-admin/login` treated any defined role
  list as a session, but `getPermissions()` returns `[]` when nothing is stored, so a signed-out
  visitor got "Not authorized" with no Sign in button. An empty role list now counts as signed
  out.
- **No way out of a non-platform-admin session.** After signing in to a sandbox as its admin, the
  page showed "Not authorized" and offered nothing else; the only escape was clearing site data.
  The card now has "Sign in with a different account", which drops the stored session and opens
  Zitadel's login prompt.
- Tests: empty role list shows Sign in; the switch button clears the session before redirecting;
  a plain sign-in does not clear it; the platform-admin redirect is unchanged.
