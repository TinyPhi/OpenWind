# Third-Party API Phase D — File Attachments

> Let a third party attach a file to a ticket or comment via a presigned, direct-to-storage
> upload flow, adapted to OpenWind's local-disk file storage (no S3 in this stack).

status: draft
created: 2026-08-24
updated: 2026-08-24

---

## §G Goal

A third-party application can upload a file and attach it to a ticket (at create time) or a
comment (at post time), without ever putting file bytes through the JSON body of the
ticket/comment endpoint. Uploaded files go through the same AV-scan + tenant-ownership pipeline
as human-UI uploads (`@platform/files`) — no parallel, weaker path.

---

## §C Constraints

| constraint      | value                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stack           | Hono routes (`apps/api/src/routes/third-party/`), `@platform/files` (local-disk storage, not S3 — PR #340), BullMQ AV scan                                          |
| auth            | Dual-identity: API key + acting-person token (ADR-012), same as Phase B/C                                                                                           |
| storage         | Local disk via `saveUpload`/`getFileStream` in `@platform/files` — no S3 presigned PUT exists in this codebase                                                      |
| file limits     | Max 10MB/file, max 10 files/ticket (declared size checked at presign, real size re-verified at completion)                                                          |
| upload slot TTL | 5 minutes; unused slots swept by the existing file-cleanup job pattern                                                                                              |
| MIME allowlist  | Reuse `apps/api/src/routes/files/initiate.ts`'s `ALLOWED_MIME_TYPES` set — no separate allowlist for third-party callers                                            |
| out of scope    | Real S3 presigned URLs (no S3 in this stack); active third-party notification on scan failure; fixing the decompression-bomb residual risk (documented, not closed) |

---

## §I Interfaces

**Upload flow (adapted presign — not real S3):**

1. `POST /api/v1/attachments/presign` — `{ filename, sizeBytes, mimeType, ticketId? }` →
   validates against 10MB/file, returns `{ attachmentId, uploadUrl, expiresAt }`. `ticketId` is
   **optional** (omitted when attaching during ticket _create_, since the ticket doesn't exist
   yet) but when present, presign requires the same comment-access check comment-post uses
   (`hasEntityCommentAccessFull`) on that ticket — closes the abuse case of an authenticated key
   with no real access to any ticket minting unbounded storage slots. `uploadUrl` is a
   short-lived, single-use, OpenWind-hosted endpoint (not a real S3 presigned URL) bound to
   exactly this `attachmentId` — it accepts exactly one successful `PUT` of the exact declared
   byte size, then is permanently invalidated (a second `PUT` to an already-completed or
   already-expired slot gets `409`/`410`, never silently overwrites).
2. Third party `PUT`s raw file bytes to `uploadUrl`. Bytes never pass through the JSON body
   parser of any ticket/comment route. Actual size is re-verified against the declared size at
   this step; a mismatch (real bytes larger than declared) is rejected here, before the file is
   persisted. Tenant storage quota (the existing `@platform/files` per-tenant cap) is checked
   atomically at this step, the same way `saveUpload` already does it — not reserved at presign
   time, so abandoned/never-completed slots never hold a phantom quota lock.
3. `POST /api/v1/tickets` (fields) or `POST /api/v1/tickets/:id/comments` gains an optional
   `attachmentIds: string[]` (max 10) referencing step-1 IDs whose upload (step 2) has
   completed. A referenced ID whose upload never completed is rejected (`422`) at this step. A
   referenced ID that completed upload but is still mid-AV-scan (`scanning`) is accepted — the
   ticket/comment is created immediately, attachment shown in `scanning` state. **Binding is
   permanent and single-ticket**: the first successful reference binds the attachment to that
   ticket; any later attempt to reference the same `attachmentId` from a different ticket is
   rejected (`422`) — an attachment is never shared across tickets. A `ticketId` supplied at
   presign time must match the ticket it's ultimately referenced from, or the reference is
   rejected.
4. `GET /api/v1/attachments/:id/download` — 404 unless `ready` (maps to `@platform/files`'
   `scanStatus = 'clean'`); response carries a sanitized `Content-Disposition` filename and
   `Content-Security-Policy: sandbox`.

Attachment lifecycle states (mapped onto `@platform/files`' existing `files.scan_status`):
`scanning` (`pending`) → `ready` (`clean`) | `quarantined` (`quarantined` | `scan_failed`).

---

## §R Requirements

R1: A third party can request an upload slot for a file before uploading any bytes, and cannot
use presign to bypass access control on a ticket it can't act on.
✓ `POST /attachments/presign` with a valid filename/size/MIME returns `201` with an
`attachmentId` + single-use `uploadUrl`.
✓ A request declaring a size over 10MB is rejected at presign time (`422`), before any upload
URL is issued.
✓ A request that would push the referencing ticket/comment over 10 files is rejected at
reference time (R3), not at presign time (presign doesn't know the target yet).
✓ Presign with a `ticketId` the acting person has no comment access to → `404` (same
not-403 convention), no upload slot issued.
✓ Presign with no `ticketId` (create-time attach case) succeeds for any authenticated
dual-identity caller — the slot is unbound until R3's reference step binds it.

R2: File bytes reach storage without ever passing through a ticket/comment JSON body, and
storage quota is enforced where bytes actually land, not speculatively at presign.
✓ The presign response's `uploadUrl` accepts exactly one `PUT` of raw bytes; the ticket/comment
create/comment-post request bodies contain only an `attachmentIds` array of strings, never
file content.
✓ A file that uploads with more bytes than its declared size is rejected at upload-completion
time, not silently truncated or accepted.
✓ A second `PUT` to an already-completed upload slot is rejected (`409`), never overwrites the
first upload.
✓ A `PUT` after the slot's 5-minute expiry is rejected (`410`).
✓ Upload completion that would exceed the tenant's storage quota is rejected atomically at that
point (same `SELECT FOR UPDATE` pattern as `saveUpload`); an abandoned, never-completed slot
never holds a quota reservation in the meantime.

R3: A ticket or comment can reference completed uploads by ID, and an attachment is bound to
exactly one ticket for its lifetime.
✓ Referencing an attachment ID whose upload never completed (no bytes arrived) → `422` at
create/comment time, ticket/comment not created.
✓ Referencing an attachment ID still `scanning` → ticket/comment created successfully,
attachment shows `scanning`.
✓ Referencing more than 10 attachment IDs on one ticket → `422`, same acceptance-limit
enforcement as the multipart human-UI path.
✓ Referencing an attachment ID belonging to a different tenant → `404` (same not-403 convention
as the rest of this API).
✓ An attachment successfully referenced by ticket A, then referenced again from a create/comment
call on ticket B → `422`, the attachment stays bound to ticket A only.
✓ An attachment presigned with `ticketId: A` but referenced from ticket B → `422`, rejected
before binding.

R4: Uploaded files are never accessible by a scanning or quarantined status.
✓ `GET /attachments/:id/download` on a `scanning` attachment → `404` or a distinguishable
"not ready" response (never streams partial/unscanned bytes).
✓ `GET /attachments/:id/download` on a `quarantined`/`scan_failed` attachment → same
not-yet-available response, never streams the file.
✓ Only `ready` (`clean`) attachments stream successfully.

R5: A failed async scan quarantines the file and leaves a durable, visible trail — without
notifying the API caller synchronously (its create call already returned success).
✓ On scan failure, the attachment's status moves to `quarantined`; the parent ticket/comment
gains an automatic system note recording why.
✓ The scan-failure event is logged via `@platform/audit` and is visible via a subsequent read of
the ticket (through the system note), never pushed back to the original API caller.
✓ No new webhook/notification channel is built for this case.

R6: Filenames never influence where a file is stored or corrupt response headers.
✓ A filename containing path-traversal characters (`../../etc/passwd`) has zero effect on the
file's actual storage location — files are stored under an OpenWind-generated internal ID,
matching `@platform/files`' existing `storageKey` pattern.
✓ A filename containing control/CRLF characters is sanitized before being placed in a
`Content-Disposition` header on download — no header injection.

R7: Download responses carry a defensive `Content-Security-Policy`.
✓ Every successful `GET /attachments/:id/download` response includes
`Content-Security-Policy: sandbox`.

R8: Abandoned upload slots don't accumulate indefinitely.
✓ A presigned upload slot not completed within 5 minutes of issuance is no longer usable — a
`PUT` after expiry is rejected.
✓ An expired, never-completed slot is swept by a periodic cleanup job (same pattern as the
existing `@platform/files` 24h-pending-file cleanup), releasing any reserved quota.

---

## §V Invariants

- Every new tenant-scoped table gets RLS + explicit `WHERE tenant_id = ?` filters (ADR-001,
  repo-wide invariant — not new to this phase, restated because attachments introduce new rows).
- `admin_audit_log.action` CHECK constraint must be extended in the same PR that introduces a
  new action string — this is the third time this class of gap has been named (0038, 0075, and
  now this note) after two real production-shaped misses; any new Phase D audit action
  (e.g. `attachment.quarantined`) needs its migration in the same commit that adds the TS union
  member, not a follow-up.
- Cross-tenant resource access returns `404`, never `403` (repo-wide convention, restated because
  attachment download/reference are new resource-access surfaces).
- File bytes are never routed through a JSON-body-parsing route — this is the entire reason
  Phase D exists instead of a simpler multipart/base64 design; any future change to this flow
  must preserve that property.
- Attachment IDs are opaque and globally-routable by design (they appear in URLs before any
  ticket binding exists) — every attachment-touching endpoint (presign, upload, reference,
  download) must independently re-check `tenant_id` and, once bound, ticket-level access; never
  assume a prior step in the same flow already proved it.

---

## §T Tasks

<!-- Expanded by /spec-tasks -->

| id  | task                                                                                                             | phase | status | depends |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----- | ------ | ------- |
| T1  | `POST /attachments/presign` — validation, attachment row (`scanning`), single-use upload token                   | 1     | todo   | —       |
| T2  | Single-use upload-token `PUT` endpoint — streams to `@platform/files`, re-verifies size, enqueues AV scan        | 1     | todo   | T1      |
| T3  | `attachmentIds` on ticket-create + comment-post — reference validation (completed-only, count cap, tenant check) | 2     | todo   | T1, T2  |
| T4  | Download endpoint — status gating, `Content-Disposition` sanitization, CSP header                                | 2     | todo   | T2      |
| T5  | Scan-failure handling — quarantine, system note, audit log, admin alert hook                                     | 2     | todo   | T2, T3  |
| T6  | Orphaned upload-slot cleanup job (5 min)                                                                         | 3     | todo   | T1, T2  |
| T7  | Isolation + security tests across all of the above                                                               | 3     | todo   | T1–T6   |

phase gate: all unit + integration + isolation tests pass before advancing to next phase

---

## §B Bugs / Backprop Log

| id  | what failed                                                                                                        | root cause                                                                                                            | promoted to §V? |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| B1  | Phase C's `mention-resolution-worker.ts` audit writes silently failed against real Postgres for the life of the PR | `admin_audit_log.action` CHECK constraint never extended for new action strings (2nd occurrence after migration 0038) | yes — see §V    |

---

_spec is source of truth — update as decisions are made_
