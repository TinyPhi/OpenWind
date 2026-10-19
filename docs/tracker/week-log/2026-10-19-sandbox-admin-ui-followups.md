# 2026-10-19 — Sandbox admin-ui follow-ups (#995, #992 dashboard half)

**Session type:** Follow-ups from the review of #991
**Branch:** `fix/PLAT-995-admin-ui-sandbox-followups`
**Issues:** #995, #992 (the API half is in the job-state PR)

- **Dashboard (#992).** The sandbox list has no cursor, so a sandbox past the page was invisible. The dashboard now asks
  for the API's maximum page (`?limit=500`) and shows "Showing the 500 most recent sandboxes; older ones are not listed"
  when `hasMore` is true. A real cursor is still open.
- **Create-sandbox modal (#995).**
  - Closing after a poll error now refreshes the list (`onCreated`) when a job was started and has not failed, because the
    sandbox may exist even though polling lost track of it. A failed provisioning still just closes.
  - After a poll error with the job possibly still running, the modal says the credentials are shown only once and that
    closing means they will not be seen.
  - If the job completed but the handover fetch fails, the modal says the credentials could not be loaded (it used to show a
    generic progress error although polling had stopped).
  - "Copied!" is now announced to assistive technology through an always-present live region.
- **Tests (#995).** The two dashboard "after unmount" tests asserted on an empty DOM and passed with or without
  `isMountedRef`; removed with a comment (the superseded-refresh test is the real guarantee). A string-valued `roles`
  payload now has a test (the guard fails open; a bare `roles?.includes` would have redirected). Each new behaviour was
  mutation-checked: closing without a refresh fails three tests, a dropped truncation flag fails one, a bare `.includes`
  fails one.
- **Spec.** B13 named the wrong modules (`@platform/db` and `jwks.js`, not `@platform/auth`); B11 and B14 said "fixed" for
  test-only additions on code that was already correct.
- **Decided not to change.** The clipboard text stays raw: a formula-trigger prefix would corrupt a password that started
  with `=`, `+`, `-` or `@`, and the server generates every value (usernames and emails are slugs, passwords start `Ow-`).
  The reasoning is now a comment in `formatHandoverClipboard`. The late-"Copied!" timer after a reset is harmless (it
  reverts in two seconds, before any next handover can appear) and was left alone.
