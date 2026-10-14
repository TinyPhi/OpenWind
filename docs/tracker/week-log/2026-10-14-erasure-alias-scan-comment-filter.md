# 2026-10-14 — GDPR: limit the erasure alias scan to comment rows (#914)

**Session type:** Code
**Branch:** `fix/PLAT-914-erasure-alias-scan-comment-filter`

- Follow-up to PrabhuVijit's R1 observation on #907: the alias-collection query in `scrubComments` expanded `mentionIdentifiers` for every `workflow_events` row in the tenant. It and the per-alias UPDATE now also require `metadata ->> 'type' = 'comment'`.
- Narrower than #914 first read: Pass 1 is already narrowed to rows whose `mentions` array contains the target, and Pass 2 already filters on `type = 'comment'`, so only the #907 code needed the prefilter.
- Added an isolation test: a non-comment event carrying a recorded alias is neither collected nor rewritten. It fails without the filter.
- No index added; not measured on a large tenant. Erasure is rare and non-interactive.
