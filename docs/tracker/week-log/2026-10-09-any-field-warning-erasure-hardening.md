# 2026-10-09 — "any field" trigger warning and erasure hardening (#767, #769)

**Session type:** Follow-ups from PrabhuVijit's reviews of #763 and #766
**Branch:** `feat/PLAT-767-erasure-hardening-any-field-warning`

- #767: the automation wizard's "Field changed" trigger now shows an inline note when an entity
  type is selected and Field is "— any field —": the rule fires on every update to every record of
  that type. No record count; that would need a new API endpoint and the issue marks it optional.
  New `step-trigger.test.tsx` covers shown / hidden-after-field-picked / hidden-before-entity-type.
- #769 item 3: `scrubComments` now states that the user-id redaction is case-sensitive (unlike the
  email match) and assumes lowercase ids. Comment only.
- #769 item 4: new `openwind_mention_record_failure_total` counter
  (`packages/telemetry/src/metrics.ts`), incremented in the `mention-resolution-worker` catch around
  `recordResolvedMention`. Unlabelled on purpose (no per-tenant cardinality); `tenantId` stays in the
  log line. The existing "finishes the tag outcome even when recording fails" test now asserts it.
- #769's "accepted known gaps" (login-name redaction, pre-#766 erasures, post-erasure mentions) are
  the owner's call and are untouched, so #769 stays open.
