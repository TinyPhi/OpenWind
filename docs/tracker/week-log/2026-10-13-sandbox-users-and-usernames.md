# 2026-10-13 — sandbox Users page, handover labels, short usernames

**Session type:** Fixes found in manual testing
**Spec:** `docs/specs/multi-org-sandbox.md` R3
**Branch:** `fix/sandbox-usernames` (from `main`, after #869 merged)

- **Users page empty in a sandbox.** `listUserRolesByUserId(orgId)` ignored `orgId`: Zitadel's v1
  user-grant search defaults to the caller's own (main) org, so a sandbox's users never got their
  roles and `/users` (holders of `user`) came back `[]`. The search now sends `x-zitadel-orgid`.
  A live check against a real sandbox org returned 20 users: 1 `admin` and 19 `user`.
- **Handover labels.** Non-admin accounts showed "(member)", the template's internal name. They
  now show the granted role, "(user)".
- **Short usernames.** Seeded accounts had no username, so Zitadel used the email and only the
  email worked at sign-in. Provisioning now sets the username to the email's local part (the
  same suffix as the email after a clash), and the handover lists username, email and role.
  Checked live first: the sandbox org's domain policy has `userLoginMustBeDomain` off (it
  inherits the default), so the bare username is a valid, instance-unique login name.
- Tests: grant search scoped to the org; `createHumanUser` sends a username only when given;
  the worker passes the email local part, including on the suffixed retry; the handover shows
  the username and the sign-in hint.
