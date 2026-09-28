## 2026-09-27 — #688 per-user erasure: anonymize, don't delete

**Session type:** GDPR fix, api service only (no migration)
**Branch:** `fix/PLAT-688-user-ref-erasure`, stacked on #681
**Spec:** `docs/specs/user-erasure-anonymization.md`

### Policy (owner decision, 2026-09-27)

Keep as much business data as the law allows: anonymize identity, keep the record. Use one flat
`[REDACTED]` placeholder, with no per-user pseudonym, because linkability can re-identify
someone. This is an engineering reading of Recital 26; **counsel should confirm the retention
list.**

### Done

- **Newly scrubbed:**
  - `user_ref` custom fields: optional ones removed, required ones redacted.
  - Comment `mentions`.
  - `actorName` snapshots on events the user authored.
  - `@<display name>` in comments that recorded a mention of the user. Same-named people in
    other comments are untouched.
- **Delete → anonymize:**
  - API keys the user created stay active on a forced 30-day rotation window (`expires_at`),
    with one audit entry per key. That's the Stripe/GitHub-App pattern for org-owned
    credentials.
  - Resolved access requests. Pending ones are still deleted.
  - Every on-call shift, with the primary redacted. The resolver pages backup, then escalation.
- **Guard:** `USER_ID_FIELD_TYPES` is an exhaustive map over field types, so a new type fails
  typecheck until it's classified.

### Review

The code review and security pass found: prefix over-matching in the `@name` rewrite, raw ids
left in `actingPersonId` and in field-change history, on-call deletion removing backup cover,
erased users' keys staying live and untraceable, and no cross-tenant test for the JSON scrub.
All are fixed with tests. Third-party email mentions are filed as #689.

### Verification

- The new isolation test failed 6/8 before the fix and passes after (12 cases with the review additions).
- All erasure suites pass: 33 tests.

### Still manual / deferred

- Unmentioned free-text references to a person.
- Notification titles and bodies sent to _other_ users (left to the #636 retention sweep).

### Review round 3 (2026-09-28)

- Removed a dead `workflow_events` UPDATE that matched and rewrote `triggered_by`. That column
  holds the trigger type (`user`, `automation`, `api`, `system`), so the UPDATE never matched and
  would have corrupted the type if it had. #681's name-based column guard had listed it as a
  handled user column; it is now in `USER_REFERENCE_COLUMNS_EXEMPT` with that reason. The author scrub was already correct: the `actor_id`
  UPDATE anonymizes `actorId` and `metadata.actorName`. The isolation test now asserts
  `actor_id = [REDACTED]` and `triggered_by = 'user'` on the target's comment.
- Noted at the on-call UPDATE that the schedule user columns have no FK to `tenant_users`
  (migration 0094), so redacting them can't block the final `tenant_users` DELETE.
- Merged main after #681's squash (0125 → 0126 renumber).
