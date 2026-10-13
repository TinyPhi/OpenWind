# 2026-10-12 — send the user to login when the session is gone

**Session type:** UX/auth fix (requested during manual testing)
**Branch:** `fix/admin-ui-session-expiry-redirect`

- Problem: when a request got a 401 and the silent token refresh also failed, `fetchWithAuth`
  showed a dismissable "session expired" banner and threw, and `fetchRawWithAuth` returned the
  401 silently. Only Refine's own data hooks reach `authProvider.onError`'s logout, and most
  pages call `fetchWithAuth` directly, so the UI stayed up while every request failed in the
  background.
- Now a 401 that survives the refresh retry clears the local session (`removeUser` +
  `emitSessionEnd`) and hard-navigates to `/login`, or `/platform-admin/login` from a
  `/platform-admin/*` page, from both helpers. It fires once however many requests fail
  together, and never from a login page or `/auth/callback` (no loop). The new module is
  `apps/admin-ui/src/lib/session-expiry.ts`.
- Only real session failures count: error `UNAUTHORIZED`, or a bare 401 with no code. I audited
  every 401 the API can send the admin-ui; the only other one is the platform-admin MFA
  `INVALID_CODE`, which stays a normal error, so a mistyped code doesn't log anyone out.
- The login page shows "Your session has expired. Please sign in again." once, via a
  sessionStorage notice consumed by `GlobalErrorBanner`. That banner is mounted above every
  route, so both login pages get it without changes. The old "Log in again" banner button had no
  remaining trigger and was removed with its `network.logInAgain` string.
- Tests: `session-expiry.test.ts` (classification table, both redirect targets, single-fire,
  no-loop on 3 paths, redirect even if `removeUser` fails, one-shot notice), `api.test.ts`
  (both helpers end the session only on a session-level 401, not after a successful retry, not
  on `INVALID_CODE`), `global-error-banner.test.tsx` (notice shown once, not auto-dismissed,
  dismissable). The full admin-ui run had 2 `lazy-routes.test.ts` dynamic-import timeouts
  under load; that file passes 65/65 alone and doesn't touch this code.
