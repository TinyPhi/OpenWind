# 2026-10-15 — PR #937 independent-review follow-ups

**Branch:** `feat/PLAT-hardening-sod-condition-operators`

- **Done.** Spec §K and the CHANGELOG now say that a direct state write (`PATCH /entities/:id` with `currentState`,
  or the child-status route) bypasses these rules until the guarded override (#941) merges, so they should not be
  enabled on a real workflow before then. §K also records that a record with no user creator has no
  `actor_not_creator` conflict; the unit test for it already existed.
