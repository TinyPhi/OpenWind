# 2026-10-15 — daily Zitadel machine-key expiry digest

**Session type:** Owner request after reviewing how OpenWind authenticates to Zitadel
**Branch:** `feat/zitadel-key-expiry-alerts`

- **Why.** OpenWind holds three Zitadel machine-user private keys (management, sandbox
  provisioning, notification), probably created without an expiry. Rotation is manual and
  nothing reminded anyone. The owner chose manual rotation now, with a guard rail; automatic
  rotation waits for OpenBao (ADR-023) and its own ADR.
- **What.**
  - `OPS_ALERT_EMAIL`, a validated comma-separated list in `@platform/config`, kept in env
    rather than the database because it's deployment-level and not tenant data.
  - `listMachineKeys` (Zitadel v4 UserService `ListKeys`, read-only) and
    `checkMachineKeyExpiry` in `packages/auth`. Each check reads each configured key's id and
    user from the env and asks Zitadel for its live expiry; nothing is stored, so a rotation
    is picked up on the next run. An absent date or a placeholder 50+ years out counts as
    "never expires".
  - A worker job, daily at 06:00 and once at start. It sends ONE digest for all keys, since
    they're rotated together, only when a key's state changes; expired, missing and unknown
    repeat daily, never-expires weekly. It's delivered through `sendDirectNotification` (the
    MFA-code path) and recorded only after a successful send. It also writes a log summary
    and two gauges, so the notification key expiring (which stops email) stays visible.
  - The runbook in `docs/deployment-hardening.md`, and a go-live checklist item.
- **Checked against the hosted Zitadel the stack uses** (owzitadel.rokkalabs.com; v4.15.1 is
  only what the separate local compose file pins). ListKeys answers 200 for all three keys
  with the current request shape, so the management user already has `user.read`. The
  management key expires 2035-01-01; provisioning and notification report 9999-12-31, so they
  never expire. That 2035 date added a "long-lived" status (over a year left), flagged weekly
  like never-expires.
- **Email format.** The first digest arrived as one run-on block: the notification service treats
  `body` as one line of plain text. A test with an HTML table arrived the same way, so the
  service doesn't render HTML either. The owner chose plain sentences that read well as a
  paragraph, one per key and most urgent first, e.g. "The management key (...793090) expires in
  2,999 days, on 1 January 2035. ... please swap it for a key with a shorter expiry." Richer
  formatting would need a change to the notification service itself, which isn't planned.
- **Tests.**
  - Config validation.
  - The ListKeys request and response mapping against a fake Zitadel.
  - Key-reference parsing (raw and base64) and states, with no key material in the output.
  - Thresholds, change-only sending, the repeat cadence, one digest for all keys, retry after
    a failed send, and log-only without an address.
- **Security review (no key-material path; nothing high or critical), fixed.**
  - Medium: the runbook said every `*_KEY_JSON` takes base64, but
    `NOTIFICATION_ZITADEL_KEY_JSON` is read as raw JSON. A lenient parser would then have
    reported a mis-pasted key as fine while email was down. The check now decodes each
    variable exactly as its consumer does, and a mis-encoded key is "unknown
    [unreadable_key_config]". The runbook lists each variable's encoding.
  - The days-remaining gauge is computed at scrape time. A check-age gauge was added, and the
    stored report expires after 3 days, so a stopped check can't leave a frozen, healthy value.
  - Each alert address gets its own stable recipient id.
  - Corrupt or future-dated stored state is treated as "no previous digest" (send, don't
    suppress). Gauge rows are validated before export.
  - An unreadable expiry date is a failed lookup, not "never expires". The runbook says
    "missing" can also mean the management user lacks `user.read` in that user's org.
