# Implementation Plan: Local Disk File Storage (replace S3/MinIO)

**Spec:** docs/specs/local-disk-file-storage.md
**Generated:** 2026-07-27
**Status:** not started

---

## Phase 1 — Core storage layer (`packages/files`)

**Goal:** Replace the S3 client calls behind the existing function signatures' successors with `fs`-based disk I/O — quota, RLS, and metadata logic untouched.
**Gate:** `pnpm test` for `packages/files` passes → then Phase 2

| task                                                                                                                                                                                            | requirement    | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| T1: Add `FILES_STORAGE_PATH` (default `/data/files`) to `@platform/config` env schema                                                                                                           | R1, R5         | todo   |
| T2: Add `STORAGE_WRITE_FAILED`/`STORAGE_READ_FAILED` to `packages/files/src/errors.ts`                                                                                                          | R1, R2         | todo   |
| T3: Implement `saveUpload` in `packages/files/src/index.ts` — quota check, write `{path}.tmp-<random>`, `fs.rename`, insert row, enqueue `av-scan` job; remove `initiateUpload`/`confirmUpload` | R1, R6         | todo   |
| T4: Implement `getFileStream` — same `FILE_NOT_FOUND`/`FILE_PENDING_SCAN`/`FILE_QUARANTINED` gating as today, returns `fs.ReadStream` + metadata; remove `getDownloadUrl`                       | R2             | todo   |
| T5: Rewrite `deleteFile` (soft delete + `fs.unlink`, best-effort/logged) and `deleteTenantFiles` (recursive `fs.rm` of tenant dir)                                                              | R4             | todo   |
| T6: Rewrite `packages/files/src/index.test.ts` against a real `os.tmpdir()`-based temp directory — no S3/AWS-SDK mocks                                                                          | R1, R2, R4, R6 | todo   |

---

## Phase 2 — API routes + AV scan worker

**Goal:** Wire the new disk-based storage functions into the HTTP layer and the ClamAV scan worker; remove all `@aws-sdk/*` usage from the runtime path.
**Gate:** `pnpm test` (integration) + `pnpm typecheck` + `pnpm lint` pass + Phase 1 gate still green

| task                                                                                                                                                                                            | requirement | status |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T7: Collapse `POST /files` + `POST /files/:id/complete` into one multipart handler (`apps/api/src/routes/files/initiate.ts`); delete `complete.ts` and its route wiring in `index.ts`           | R1          | todo   |
| T8: Rewrite `apps/api/src/routes/files/download.ts` to call `getFileStream` and pipe bytes + `Content-Type`/`Content-Disposition`/`Content-Length` headers instead of returning a presigned URL | R2          | todo   |
| T9: Verify `deleteFileHandler` (`delete.ts`) still propagates `deleteFile`'s errors correctly (route body likely unchanged — confirm, don't assume)                                             | R4          | todo   |
| T10: Rewrite `apps/worker/src/av-scan.ts` — `fs.createReadStream` piped into ClamAV INSTREAM instead of S3 `GetObjectCommand` + buffer; remove the file's standalone `S3Client` instance        | R3          | todo   |

---

## Phase 3 — Infra, config, and end-to-end verification

**Goal:** Container wiring so the fix is portable across laptop and server, plus full local proof it works.
**Gate:** §R acceptance criteria met — all four exit-condition commands pass, manual upload/download/delete/quarantine/quota/tenant-purge exercised

| task                                                                                                                                                                                                                                   | requirement | status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ |
| T11: docker-compose.yml — comment out `minio`/`minio-init` services + `minio_data` volume; add `${FILES_STORAGE_PATH_HOST}:/data/files` bind-mount to `ow-backend` + `ow-worker`; set `FILES_STORAGE_PATH=/data/files` env on both     | R5          | todo   |
| T12: Update `.env.example` with `FILES_STORAGE_PATH_HOST=../openwind-files`; add a defensive `.gitignore` entry; leave `S3_*` vars in place                                                                                            | R5          | todo   |
| T13: Local verification — `docker compose up -d` (admin-ui on port 3001), exercise upload/download/delete/quarantine/quota/tenant-purge through the running app; run `pnpm typecheck && pnpm lint && pnpm test && pnpm test:isolation` | R1–R6       | todo   |

---

## Kick-Off Prompt

Copy this into your Claude Code / AntiGravity session to start implementation:

```
Read docs/specs/local-disk-file-storage.md and docs/specs/local-disk-file-storage-tasks.md.

Implement Phase 1 tasks only (T1–T6).

Rules:
- Do not begin Phase 2 until all Phase 1 tests pass
- After each task, run relevant tests and confirm pass before continuing
- If you hit a decision not covered by the spec, stop and ask — do not assume
- If a test fails, run: /spec amend §B to log it before fixing
- If the same bug class could recur, run: /spec amend §V to make it an invariant
```
