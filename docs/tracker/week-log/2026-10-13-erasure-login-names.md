# 2026-10-13 — GDPR: erase login names by recording the identifier used (#769)

**Session type:** Code
**Branch:** `fix/PLAT-769-record-mention-identifier`

- The JWT carries no login name and `tenant_users` stores none, so erasure could not find a login name in third-party comment text. Rather than add a column and an extra userinfo call to the auth path, the mention-resolution worker now records the identifier the commenter typed for each resolved member in `workflow_events.metadata.mentionIdentifiers[<user id>]` (deduplicated, in the same atomic statement as `mentions`). Unresolved identifiers are never stored.
- `scrubComments` gathers the target's recorded identifiers from the tenant's comments and redacts them, case-insensitively, only in the comments that recorded them (3+ characters), then drops the target's `mentionIdentifiers` entry. Login names are plain words, so they are deliberately not scanned for tenant-wide.
- Residual: a login name in a comment resolved after the erasure stays in its text (the worker skips a user who is no longer a member). Recorded in spec §B7.
- #769 item 4 (a counter for mention-recording failures) already exists as `mentionRecordFailureTotal` in `@platform/telemetry`, used in the mention-resolution worker.
- Security-reviewer pass found three things, all fixed: (1) `getWorkflowEventLog` returned comment metadata wholesale to anyone with ticket access, so `mentionIdentifiers` would have leaked a user-id-to-login-name map; it is now stripped in the engine, the single choke point for both event-log routes; (2) a recorded login name was applied to every comment mentioning the target, so it is now redacted per alias only in the comments that recorded it; (3) the gather query now guards non-array values so a malformed field can't abort an erasure.
