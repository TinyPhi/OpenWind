# 2026-10-14 — Test follow-ups from the #917 review (#914)

**Session type:** Code
**Branch:** `test/PLAT-914-erasure-alias-test-assertions`

- Review suggestion B: the non-comment event test now asserts the row's whole metadata is unchanged, including `mentionIdentifiers`, not only `text`.
- Review suggestion A, adjusted: a comment row recording the same alias is added, and its text is asserted redacted while the non-comment row stays untouched. The literal scenario (alias not collected from a non-comment row) cannot fail on its own: the per-alias UPDATE already requires the alias in the row's own `mentionIdentifiers`, so collecting it from a non-comment row changes no other row. The UPDATE's `type = 'comment'` filter is what the test pins; removing it fails the assertion.
- Test-only change; no source change.
