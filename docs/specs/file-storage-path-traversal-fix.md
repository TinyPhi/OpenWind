# Spec: Fix path traversal / arbitrary file write in local-disk file storage

**Status:** implemented, pending review
**Relates to:** `docs/specs/local-disk-file-storage.md` (the feature this bug was found in)
**Reported by:** external worktree/agent review of the `tushar` branch

---

## §B — Background

`POST /files` accepts a client-supplied `moduleSlug` field that `buildStorageKey()`
(`packages/files/src/index.ts`) embeds verbatim into the on-disk storage path:

```
${tenantId}/${moduleSlug}/${entitySegment}/${safeName}
```

`resolveStoragePath()` then does a bare `path.join(env.FILES_STORAGE_PATH, storageKey)`
with no containment check. `path.join` normalizes `..` segments but does not clamp the
result to stay inside a base directory.

`moduleSlug` was validated in `apps/api/src/routes/files/initiate.ts` only as
`z.string().min(1).max(100)` — no character restriction, unlike `entityId` (UUID-validated)
and `filename` (reduced server-side to `${fileId}.${ext}`, `fileId` being a server-generated
UUID). The route allows all three roles (`admin`, `agent`, `user`).

**Impact:** any authenticated user of any role could set `moduleSlug` to a traversal
payload (e.g. `../../../../../../tmp/pwned`) and an arbitrary file body, causing the
server to write attacker-controlled bytes to an attacker-chosen path outside the storage
root, subject only to OS file permissions. Because the DB persists that same
attacker-controlled `storageKey`, later reads (`GET /files/:id`) and the ClamAV scan step
also operate on the escaped path — both a write and a read primitive outside the
containment boundary. Confirmed via direct code inspection (not a false positive, not a
deliberate design choice) — verified against `packages/files/src/index.ts` and
`apps/api/src/routes/files/initiate.ts` on `tushar` HEAD.

---

## §R — Requirements

- **R1:** `moduleSlug` must be rejected at the API boundary unless it matches the
  platform's kebab-case module-slug convention (`^[a-z0-9-]+$`) — no path separators,
  no `..` sequences, no other characters.
- **R2:** `resolveStoragePath()` must assert (defense-in-depth) that the resolved
  absolute path is contained within `env.FILES_STORAGE_PATH`, and throw a typed
  `FileError` if not — so a future caller that skips the R1 boundary check (or a
  legacy stored `storageKey`) can never escape the storage root.
- **R3:** Neither fix changes behavior for legitimate uploads — all existing module
  slugs in the repo are already kebab-case, so R1 is invisible to real usage; R2 only
  triggers on paths that should never occur once R1 is in place.
- **R4:** Existing file-route and `@platform/files` test suites must continue to pass
  unmodified, and new tests must cover the traversal payloads described in §B.

---

## §I — Interfaces touched

- `apps/api/src/routes/files/initiate.ts` — `UploadFieldsSchema.moduleSlug` (Zod schema)
- `packages/files/src/index.ts` — `resolveStoragePath()`
- `packages/files/src/errors.ts` — `FileErrorCode` (new `STORAGE_PATH_ESCAPE` member)

No DB schema change, no new migration, no API response shape change, no UI change.

---

## §V — Invariants

- Every path segment derived from client input and used in a storage-path template
  must be validated against a closed character set (or a server-generated value) —
  never an unconstrained string, even if "surely no one would put `..` there."
- `resolveStoragePath` (or the equivalent for any future storage backend) must always
  assert path containment in code, not rely solely on upstream validation.

---

## §T — Tasks (see `-tasks.md` for the expanded phase plan)

| task                                                                          | requirement | status |
| ----------------------------------------------------------------------------- | ----------- | ------ |
| T1: Restrict `moduleSlug` to `^[a-z0-9-]+$` in the Zod schema                 | R1, R3      | done   |
| T2: Add containment assertion + `STORAGE_PATH_ESCAPE` to `resolveStoragePath` | R2, R3      | done   |
| T3: Add traversal-payload regression tests (API route + package)              | R4          | done   |
| T4: Typecheck + lint + existing test suites green                             | R4          | done   |
