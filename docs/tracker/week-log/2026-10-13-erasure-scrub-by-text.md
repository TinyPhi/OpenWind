# 2026-10-13 — GDPR: erasure finds identifiers by text (#769)

**Session type:** Code
**Branch:** `fix/PLAT-769-erasure-scrub-by-text`

- `scrubComments` in `user-erasure.ts` now runs a second pass: the erased user's email and user id are redacted in any comment of the tenant, not only comments whose `metadata.mentions` lists them. This closes #769's gap 3 (a mention resolved after the erasure, or never) and, since no production data exists, makes gap 2 (users erased before #766) not applicable.
- V2 is narrowed to display names: `@<display name>` is still rewritten only in comments that recorded a mention, because names collide. Emails and user ids are unique, and the existing boundary rules (not inside a longer address or id) still apply.
- Spec `user-erasure-anonymization.md` §V and §B7 updated. Gap 1 (login names, needs a `tenant_users.login_name` column) and the mention-failure counter (item 4) are still open on #769.
- Tests: the old "unmentioned comment keeps the email (V2)" test is replaced by the new behaviour, plus an unmentioned user-id case that keeps a longer id and another person's email. Both new tests fail on the old service.
- Security-reviewer pass found nothing blocking. Two low-severity points were taken: the text-wide pass only applies to user ids of 8+ characters (Zitadel ids are ~18 digits), and the email guard now requires a `local@domain` shape.
- One full `pnpm test` run failed once with no log captured, then passed twice with logs; not reproduced, cause unknown.
