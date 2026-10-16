# 2026-10-16 — Deleting the last comment attachment

**Session type:** Bug fix
**Branch:** `fix/PLAT-hardening-last-attachment-delete`
**Found by:** security review of the metadata guard (migration 0148)

- **Done.** `delete-comment-attachment.ts` built the new `fileIds` with `jsonb_agg`, which is NULL over zero
  rows, so removing the last file made `jsonb_set` return NULL and the `metadata` NOT NULL column refused the
  update. The expression is now `removeFileIdFromMetadata` and wraps the aggregate in `COALESCE(..., '[]')`.
- **Verified.** An isolation test on real Postgres (`comment-attachment-delete.isolation.test.ts`) fails before the
  change with the NOT NULL violation and passes after; it also covers removing one of several files and a missing id.
- **Deferred.** The route itself still has no HTTP-level test (authorization and 404 paths); the test covers the
  SQL expression only.
