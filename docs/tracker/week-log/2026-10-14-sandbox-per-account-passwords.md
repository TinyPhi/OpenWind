# 2026-10-14 — per-account passwords for seeded sandbox accounts

**Session type:** Owner-requested change from manual testing
**Spec:** `docs/specs/multi-org-sandbox.md` R3, R5, T21
**Branch:** `feat/sandbox-per-account-passwords`

- **Before:** provisioning generated one random password per sandbox and gave it to every seeded
  account, so anyone handed one account knew all of them, the admin's included.
- **Now:** every account gets its own crypto-random password (same Zitadel-policy-safe format). A
  clash retry keeps the account's password. The handover stores and returns
  `{ username, email, role, password }` per account; the sandbox-wide `defaultPassword` is gone.
- **Not derived from username + user id** (the owner's first idea): both are visible to everyone
  in the sandbox org, so such a password could be computed by any colleague. Random per account
  avoids that and needs no second Zitadel call.
- **Older handovers** (stored with one `defaultPassword`) are still readable for the rest of
  their 7-day TTL: the store copies that password onto each account when it reads them.
- The handover screen shows a table of username/email, role and password instead of one
  "Default password" block. Passwords still live only in Redis (7-day TTL), never in the DB,
  the progress view or the BullMQ job result.
- Tests: every account (1 admin + 4 members) gets a distinct password, a retry reuses it, the
  handover matches what was sent to Zitadel, no password appears in the job result or progress
  row; the store reads both the new shape and the legacy one; the modal shows each password.
