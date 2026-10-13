# 2026-10-13 — platform-admin dashboard shows the Zitadel user id instead of a name

**Session type:** Bug fix (found in manual testing)
**Spec:** `docs/specs/multi-org-sandbox.md` R1 (platform-admin identity)
**Branch:** `fix/platform-admin-display-name`

- The dashboard's "Signed in as" line showed the raw Zitadel user id. The platform-admin access
  token carries no `name` (and here no `email`) claim, so `extractPlatformAdminContext` falls back
  to the user id. `resolvePlatformAdmin` already called the userinfo endpoint for a missing email,
  but only copied the email across.
- It now also fills `displayName` from the userinfo response (name, then email) whenever the token
  only gave the user id, the same rule `requireAuth` uses for tenant users. `fetchUserInfo` is
  cached per token, so this adds at most one lookup per session token, and none when the token
  already has a name and email.
- Tests: no name in the token gives the userinfo name; userinfo without a name gives its email; a
  token with name and email makes no userinfo call; a failed userinfo call keeps the id without
  failing the request.
