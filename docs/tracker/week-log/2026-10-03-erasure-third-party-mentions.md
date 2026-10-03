# 2026-10-03 — erasure now redacts third-party comment mentions (#689)

**Session type:** GDPR fix (owner chose option 1: record resolved mentions)
**Branch:** `fix/689-erasure-third-party-mentions`

- **The gap.** Third-party comments mention people by identifier (email, login name, user id)
  and never carried `metadata.mentions`, so per-user erasure (#688) never found them. Option 1
  alone wasn't enough, because the scrub only rewrote `@<display name>`. This PR also redacts
  identifiers.
- **Worker.** `recordResolvedMention` (`apps/worker/src/record-resolved-mention.ts`) appends a
  resolved tenant member's id to the comment's `metadata.mentions`:
  - it's one atomic, de-duplicating update
  - it's safe under concurrent jobs, as an isolation test shows
  - it never NULLs metadata when the key is missing
  - it skips non-members
  - it runs for every job, to keep timing equal (R5/R6)
  - a failure is logged and doesn't block the tag outcome
- **Erasure.** In comments that mention the target, `scrubComments` now also redacts their
  email (case-insensitive, not inside a longer address) and user id. Comments that don't
  mention them are still untouched.
- **Migration 0133 (data only).** Backfills mentions on existing third-party comments from the
  `tag.*` audit trail, members only. It must merge after #763 (0132), which must merge after
  #759 (0131).
- **Tests.**
  - Worker: 7 new unit tests, plus the new `record-resolved-mention.isolation.test.ts` (6).
  - API: the new `erasure-third-party-mentions.isolation.test.ts` (10). Its 3 redaction tests
    fail against the old erasure code.
  - The #688 erasure suite still passes.
- **Security review.** Fixed one bug: an email ending a sentence ("… alice@x.com.") was not
  redacted. Also added backfill test cases that only the cross-tenant join conditions can
  satisfy.
- **Known gaps** (in spec §B7): login names aren't redacted, users erased before this shipped
  keep their identifiers, and mentions resolved after an erasure aren't recorded.
