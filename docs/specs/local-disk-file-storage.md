# Local Disk File Storage (replace S3/MinIO)

> Swap `@platform/files`' S3/MinIO backend for local-disk storage so uploads/downloads work on the real server (no `S3_PUBLIC_URL=localhost` breakage) — metadata model, RLS, and AV-scan gating unchanged.

status: draft
created: 2026-07-27
updated: 2026-07-27

---

## §G Goal

`POST /files` writes bytes straight to a server-local directory in the same request;
`GET /files/:id` streams bytes straight back after the existing tenant+entity-ACL check.
No presigned URLs anywhere. Single API/worker instance, host bind-mount volume — same
mount path on laptop and server, driven by config not a hardcoded path, so the fix is
portable rather than tied to one machine. Existing `files` table, RLS, quota logic, and
AV-scan gating semantics stay exactly as they are — only the byte storage mechanism changes.
No storage-adapter abstraction — direct `fs` calls; a future S3 return would be a scoped
rewrite of `packages/files/src/index.ts`, not a config flag (explicitly not building for
that hypothetical now).

## §C Constraints

| constraint       | value                                                                                                                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack            | `node:fs`/`node:fs/promises`, Hono `c.req.parseBody()` — no new multipart/streaming dep                                                                                                                                                                                                   |
| topology         | single API instance, single worker instance — no shared-volume-across-replicas design needed                                                                                                                                                                                              |
| auth             | unchanged — `requireAuth()` + `requireRole()` + entity-ACL check on download, exactly as today                                                                                                                                                                                            |
| storage path     | in-container path fixed at `/data/files` (mounted into `ow-backend` + `ow-worker`); the host-side bind-mount source is `FILES_STORAGE_PATH_HOST` (new, in `.env`, default `../openwind-files` — sibling dir to the repo checkout, same on laptop and server, no repo-relative hardcoding) |
| path layout      | `{FILES_STORAGE_PATH}/{tenantId}/{moduleSlug}/{entityId\|unattached}/{fileId}.{ext}` (unchanged nesting from today's `buildStorageKey`, S3 key → fs path); `FILES_STORAGE_PATH` is the fixed in-container path (`/data/files`), not the host path                                         |
| max file size    | unchanged — `MAX_FILE_BYTES` = 100MB, quota via `tenants.config.storage_quota_mb` (no new cap)                                                                                                                                                                                            |
| upload parsing   | buffer full file via `c.req.parseBody()` (no streaming multipart parser)                                                                                                                                                                                                                  |
| write durability | write to `{path}.tmp-<random>` then `fs.rename` into place — no partial file ever visible                                                                                                                                                                                                 |
| av-scan read     | `fs.createReadStream(path)` piped into ClamAV INSTREAM (streaming, not buffered)                                                                                                                                                                                                          |
| range requests   | out of scope — full-file response only                                                                                                                                                                                                                                                    |
| S3 removal scope | comment out MinIO/minio-init/volume in docker-compose; keep `S3_*` vars in `@platform/config` (unused) for now                                                                                                                                                                            |
| data migration   | none — no production data exists in MinIO today, clean cutover                                                                                                                                                                                                                            |
| out of scope     | multi-replica/shared-volume storage, Range/206 support, deleting `S3_*` env schema, migrating existing S3 objects, storage-adapter abstraction for a hypothetical future S3 return                                                                                                        |

## §I Interfaces

**Route contract changes** (`apps/api/src/routes/files/`):

| route                      | today                                                  | after                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /files`              | JSON body → creates row, returns presigned PUT URL     | multipart body (metadata fields + file) → writes bytes to disk, creates row, enqueues av-scan, returns `{ data: { fileId, scanStatus: "pending" } }` (201) — collapses today's initiate+complete into one call |
| `POST /files/:id/complete` | confirms upload, enqueues av-scan                      | **removed** — folded into `POST /files`                                                                                                                                                                        |
| `GET /files/:id`           | JSON `{ data: { downloadUrl, downloadUrlExpiresAt } }` | binary response body, `Content-Type`/`Content-Disposition`/`Content-Length` headers set from `files` row, same 404/422 gating as today                                                                         |
| `GET /files/:id/status`    | unchanged                                              | unchanged                                                                                                                                                                                                      |
| `DELETE /files/:id`        | soft delete + fire-and-forget S3 delete                | soft delete (`scan_status='deleted'`) + immediate `fs.unlink` of bytes                                                                                                                                         |

**`packages/files/src/index.ts` exported function changes:**

| function              | today                                            | after                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `initiateUpload`      | quota check + insert row + presigned PUT URL     | **removed** — replaced by `saveUpload`                                                                                                                                                                                                           |
| `saveUpload` (new)    | —                                                | `(db, redis, tenantId, uploadedBy, moduleSlug, entityId, filename, mimeType, bytes: Buffer) => Promise<{fileId, scanStatus}>` — quota check, write temp file + rename, insert row, enqueue `av-scan` job (same dedup `jobId: av-scan-${fileId}`) |
| `confirmUpload`       | marks upload done, enqueues scan                 | **removed** — folded into `saveUpload`                                                                                                                                                                                                           |
| `getDownloadUrl`      | presigned GET URL if `scanStatus==='clean'`      | **removed** — replaced by `getFileStream`                                                                                                                                                                                                        |
| `getFileStream` (new) | —                                                | `(db, tenantId, fileId) => Promise<{stream: fs.ReadStream, originalName, mimeType, sizeBytes}>` — same `FILE_NOT_FOUND`/`FILE_PENDING_SCAN`/`FILE_QUARANTINED` gating as today                                                                   |
| `deleteFile`          | soft delete + fire-and-forget S3 delete          | soft delete + `fs.unlink` (best-effort, log on failure, don't fail the request)                                                                                                                                                                  |
| `deleteTenantFiles`   | batch `DeleteObjectsCommand` by storage key list | `(tenantId) => Promise<void>` — recursive `fs.rm(FILES_STORAGE_PATH/tenantId, {recursive:true})`                                                                                                                                                 |

`storage_key` column semantics unchanged (relative path under `FILES_STORAGE_PATH`, same nesting), comment updated from "S3 path" to "disk path relative to FILES_STORAGE_PATH".

**New env vars:**

```
# @platform/config (read by app code — in-container path, same value in every environment)
FILES_STORAGE_PATH: z.string().default("/data/files")

# .env only (docker-compose interpolation, NOT read by app code) — host bind-mount source
FILES_STORAGE_PATH_HOST=../openwind-files   # sibling dir to the repo checkout, default in .env.example
```

**New error codes** (`packages/files/src/errors.ts`): `STORAGE_WRITE_FAILED`, `STORAGE_READ_FAILED` — map to 500, logged with `tenantId`/`fileId`/`error.code` (pino), generic message to client, no path/errno leaked.

## §R Requirements

R1: Upload writes bytes to disk atomically in the same request that creates the DB row.
✓ `POST /files` with multipart body containing a file under the size limit returns 201 with a `fileId`, and a file exists at the expected disk path immediately after
✓ Killing the write mid-request (simulated via injected fs error) never leaves a partial file visible at the final path — only `.tmp-*` artifacts, which don't satisfy any read
✓ DB row is only inserted after the rename to final path succeeds

R2: Download streams bytes directly from disk after the existing ownership/ACL checks, with no functional change to access control.
✓ `GET /files/:id` for a `clean` file returns 200 with correct `Content-Type`/`Content-Disposition` headers and byte-identical body to what was uploaded
✓ `GET /files/:id` for another tenant's file (or without entity ACL) returns 404 (`FILE_NOT_FOUND`), never leaking existence — unchanged from today
✓ `GET /files/:id` for `pending`/`scan_failed`/`quarantined`/`deleted` returns the same error codes as today (`FILE_PENDING_SCAN`/`FILE_QUARANTINED`/`FILE_NOT_FOUND`)

R3: AV scan reads the file from local disk via streaming, not from S3.
✓ `av-scan.ts` no longer imports or calls any `@aws-sdk/*` package
✓ Scanning a file streams it into the ClamAV INSTREAM socket without buffering the whole file into a `Buffer` first
✓ Clean/quarantined/scan_failed transitions behave identically to today (same DB updates, same notification on quarantine, same outbox `system.error` on final failure)

R4: Single-file and tenant-purge deletion remove bytes from disk, matching today's "actually delete from the backing store" behavior.
✓ `DELETE /files/:id` removes both the DB visibility (`scan_status='deleted'`) and the on-disk file; a subsequent disk check shows no file at that path
✓ Tenant purge removes the entire tenant's directory tree under `FILES_STORAGE_PATH`; no orphaned files remain for that tenant

R5: Files persist across container recreation, on any machine (laptop or server) without path changes.
✓ `docker compose down && docker compose up -d` (no volume/dir removal) — a file uploaded before `down` is still downloadable after `up`
✓ `/data/files` is bind-mounted from `${FILES_STORAGE_PATH_HOST}` on both `ow-backend` and `ow-worker`, verified by inspecting the compose file and confirming both containers see the same host directory
✓ Running the identical `docker compose up -d` on the server (with its own `.env`) works without editing any path in code or compose — only `FILES_STORAGE_PATH_HOST` differs per environment, and it defaults sanely (sibling dir) if unset

R6: Quota enforcement and file metadata (original name, mime type, size, tenant/entity ownership, RLS) are unchanged.
✓ Uploading past `tenants.config.storage_quota_mb` still returns the existing quota-exceeded error, computed the same way (`SUM(size_bytes)` over non-deleted rows)
✓ `files` table schema, RLS policy, and all existing columns are untouched (no migration required beyond the `storage_key` comment)

## §V Invariants

- Bytes are only readable through `GET /files/:id`'s existing ownership+ACL+scan-status gate — never a directly guessable/public disk path exposed to a client.
- A `files` row is never marked ready (visible for download attempts) before its bytes are durably at the final on-disk path (temp-write-then-rename ordering).
- No S3/MinIO SDK import remains in the runtime path (`packages/files`, `apps/worker/src/av-scan.ts`) after this change — S3 client code is fully replaced, not layered alongside.
- Deleting a file (single or tenant purge) always removes bytes from disk — a soft-deleted DB row never leaves recoverable bytes behind (this app doesn't do byte-level "trash").
- Every `packages/db` query in `apps/worker/src/av-scan.ts` (and any other tenant-scoped worker code) goes through `withTenantContext` — a bare `db.select()`/`update()`/`insert()` outside it isn't just an RLS gap in theory, it throws in production against a real PgBouncer-pooled connection (`invalid input syntax for type uuid: ""` when `app.tenant_id` is unset/stale — see §B).

## §T Tasks

| id  | task                                                                                                                                                                                                              | phase | status | depends |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | Add `FILES_STORAGE_PATH` (default `/data/files`) to `@platform/config` env schema                                                                                                                                 | 1     | todo   | —       |
| T2  | Rewrite `packages/files/src/index.ts`: `saveUpload`, `getFileStream`, disk-based `deleteFile`/`deleteTenantFiles`, temp-write-then-rename helper                                                                  | 1     | todo   | T1      |
| T3  | Update `packages/files/src/errors.ts` with `STORAGE_WRITE_FAILED`/`STORAGE_READ_FAILED`                                                                                                                           | 1     | todo   | —       |
| T4  | Rewrite `packages/files/src/index.test.ts` against a real temp directory (no S3 mocks)                                                                                                                            | 1     | todo   | T2, T3  |
| T5  | Collapse `POST /files` + `/complete` into one multipart handler in `apps/api/src/routes/files/initiate.ts`; delete `complete.ts` and its route wiring                                                             | 2     | todo   | T2      |
| T6  | Rewrite `apps/api/src/routes/files/download.ts` to stream bytes + headers instead of returning a presigned URL                                                                                                    | 2     | todo   | T2      |
| T7  | Update `deleteFileHandler` to reflect disk-unlink behavior (route itself likely unchanged, verify error propagation)                                                                                              | 2     | todo   | T2      |
| T8  | Rewrite `apps/worker/src/av-scan.ts` to stream from disk into ClamAV INSTREAM, remove `@aws-sdk/*` usage                                                                                                          | 2     | todo   | T2      |
| T9  | docker-compose.yml: comment out `minio`/`minio-init`/`minio_data` volume; add `${FILES_STORAGE_PATH_HOST}:/data/files` bind-mount to `ow-backend` + `ow-worker`; set `FILES_STORAGE_PATH=/data/files` env on both | 3     | todo   | —       |
| T10 | Update `.env.example` with `FILES_STORAGE_PATH_HOST=../openwind-files`; add a defensive `.gitignore` entry for it in case it's ever pointed inside the repo; leave `S3_*` vars in place per constraint            | 3     | todo   | T1      |
| T11 | Full local verification: `docker compose up -d`, upload/download/delete/quarantine/quota/tenant-purge exercised end-to-end, `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation`                     | 3     | todo   | T1–T10  |
| T12 | Deploy: commit, push, pull on server, rebuild (same procedure as prior fixes)                                                                                                                                     | 4     | todo   | T11     |

phase gate: all unit + integration tests pass before advancing to next phase

## §B Bugs / Backprop Log

| id  | what failed                                                                                                                                                                                                 | root cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | promoted to §V? |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| B1  | Local dev: `saveUpload`'s `SKIP_AV_SCAN` branch threw `invalid input syntax for type uuid: ""` on the DB update                                                                                             | Bare `db.update()` outside `withTenantContext` — `app.tenant_id` GUC never set, RLS policy's `::uuid` cast on the empty default failed. Found via real end-to-end test against the running docker-compose stack (unit tests mocked the DB and didn't catch it).                                                                                                                                                                                                                                                                                                                                                                                                                               | Yes — see §V    |
| B2  | Production (server): every AV scan attempt failed silently, files stuck at `scanStatus: "pending"` forever, no error visible in app logs (only "Failed query", cause dropped by `err: String(err)` logging) | Same class as B1, but in **pre-existing** code (`apps/worker/src/av-scan.ts`'s idempotency-check select, both status updates, and the failure-handler update+outbox-insert) that I didn't touch when rewriting the S3→disk parts. Never surfaced before because the old S3 presigned-URL bug (the whole reason for this migration) meant uploads never reached the AV-scan queue in the first place. Confirmed root cause by reproducing the exact query through the app's own DB client inside the running worker container, which showed `PostgresError: invalid input syntax for type uuid: ""` as the `.cause`. Fixed by wrapping every DB call in `av-scan.ts` with `withTenantContext`. | Yes — see §V    |

---

_spec is source of truth — update as decisions are made_
