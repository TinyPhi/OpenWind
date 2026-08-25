# Implementation Plan: Third-Party API Phase D — File Attachments

**Spec:** docs/specs/third-party-api-phase-d-attachments.md
**Generated:** 2026-08-24
**Status:** All 3 stages done. Stage 1+2 in PR #472 (CI green). Stage 3 (scan-failure handling +
full-phase security review) on `feat/third-party-api-phase-d-scan-failure`, stacked on #472 —
PR pending. Phase D is functionally complete pending that PR's merge; Phase E's `/spec-tasks` is
clear to freeze once it lands.

Note: "Stage" below refers to this task plan's internal sequencing only — distinct from the
project-level Phase A/B/C/D naming (this whole plan implements Phase D).

**PR chunking (updated 2026-08-24):** the source planning doc
(`pr-chunking-and-sequencing-plan.md`) called for 4 separate PRs (D1 presign, D2 upload+scan
wiring, D3 scan-failure handling, D4 ticket/comment integration + download), matching Phase C's
C1/C2/C3 precedent. Implementation instead stacked Stage 1 + Stage 2 into a single PR
(**#472**, `feat/third-party-api-phase-d-attachments`) covering D1 + D2's mechanics + D4's
reference-binding/download work. Caught and corrected once noticed: **Stage 3 (scan-failure
handling, D3-equivalent) will ship as its own stacked PR** on top of #472, matching the
original chunking plan and the Phase C precedent, rather than continuing to grow #472 further.

---

## Stage 1 — Presign + Upload (core attachment lifecycle, no ticket/comment integration yet)

**Goal:** an attachment can be presigned, uploaded, and scanned, independent of any ticket.
**Gate:** all unit + isolation tests for T1–T3 pass → then Stage 2

| task | task description                                                                                                                                                                                                                                                                                          | requirement | status         |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------- |
| T1a  | `attachments` table migration: `id, tenant_id, ticket_id (nullable), uploaded_by, acting_person_id, declared_filename, declared_size_bytes, declared_mime_type, upload_token_hash, upload_expires_at, files_id (nullable FK), bound_at (nullable), status` — RLS + tenant_id index, per db-conventions.md | R1, R3      | done (PR #472) |
| T1b  | `POST /api/v1/attachments/presign` handler — dual-identity auth, size/MIME validation against the reused `ALLOWED_MIME_TYPES` allowlist, optional `ticketId` → `hasEntityCommentAccessFull` check (404 on deny), issues `attachmentId` + single-use upload token + `expiresAt` (now + 5min)               | R1          | done (PR #472) |
| T1c  | Single-use upload `PUT` endpoint — validates token + expiry (`410` if expired), streams bytes via `@platform/files`' `saveUpload` (reuses its quota `SELECT FOR UPDATE` + AV-scan enqueue), re-verifies actual size against declared size, marks slot consumed (`409` on replay)                          | R2          | done (PR #472) |
| T2   | Orphaned upload-slot cleanup job in `apps/worker` — sweeps expired, never-completed slots on the same schedule pattern as `@platform/files`' existing 24h-pending-file cleanup                                                                                                                            | R8          | done (PR #472) |
| T3   | Unit + isolation tests: presign validation (size/MIME/ticketId-access), upload completion (size mismatch, replay, expiry), quota-at-completion-not-presign, cleanup job                                                                                                                                   | R1, R2, R8  | done (PR #472) |

---

## Stage 2 — Ticket/Comment Integration + Download

**Goal:** attachments can be referenced from ticket-create/comment-post and safely downloaded.
**Gate:** all Stage 2 tests pass + Stage 1 gate still green

| task | task description                                                                                                                                                                                                    | requirement    | status         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------- |
| T4a  | `attachmentIds: string[]` (max 10) on `POST /api/v1/tickets` and `POST /api/v1/tickets/:id/comments` — validates each ID is completed-upload, unbound-or-matching-ticketId, cross-tenant → `404`, count cap → `422` | R3             | done (PR #472) |
| T4b  | Binding: first successful reference sets `attachments.ticket_id` + `bound_at`; a later reference from a different ticket → `422`                                                                                    | R3             | done (PR #472) |
| T5   | `GET /api/v1/attachments/:id/download` — 404 unless `files.scan_status = 'clean'`, sanitized `Content-Disposition`, `Content-Security-Policy: sandbox` header                                                       | R4, R6, R7     | done (PR #472) |
| T6   | Unit + isolation tests: reference validation (all R3 cases incl. single-ticket-binding + presign-ticketId-mismatch), download gating by status, filename sanitization (path traversal + CRLF), CSP header           | R3, R4, R6, R7 | done (PR #472) |

---

## Stage 3 — Scan-Failure Handling + Full Security Pass

**Goal:** a failed scan is handled safely end-to-end; the whole phase passes security review.
**Gate:** §R acceptance criteria fully met, `/security-review` clean

| task | task description                                                                                                                                                                                                                              | requirement | status                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| T7a  | Extend `AuditAction` union with `attachment.quarantined` / `attachment.scan_failed` (or reuse existing `@platform/files` scan-failure hook if one already fires) — **same commit must extend the DB CHECK constraint** (§V invariant from B1) | R5          | done (feat/third-party-api-phase-d-scan-failure)                                                    |
| T7b  | On scan failure (worker-side hook into existing AV-scan pipeline): quarantine the attachment, write an automatic system note on the bound ticket/comment, write the audit entry — no notification to the API caller                           | R5          | done (feat/third-party-api-phase-d-scan-failure)                                                    |
| T8   | Unit + isolation tests: scan-failure quarantine + system-note + audit-log-with-constraint-check (real Postgres, not mocked — per the B1 lesson), no caller-facing notification path exists                                                    | R5          | done (feat/third-party-api-phase-d-scan-failure)                                                    |
| T9   | `/security-review` across the full phase — presign-abuse (STRIDE), tenant isolation on every new endpoint, quota-bypass attempts, single-ticket-binding bypass attempts                                                                       | all         | done — found + fixed a TTL-bypass race and unbounded table growth; 2 low-severity findings deferred |

phase gate: all unit + integration + isolation tests pass before advancing to the next stage; Stage 3 additionally requires a clean `/security-review` before PR.

---

## Kick-Off Prompt

Read `docs/specs/third-party-api-phase-d-attachments.md` and
`docs/specs/third-party-api-phase-d-attachments-tasks.md`.

Implement Stage 1 tasks only (T1a, T1b, T1c, T2, T3).

Rules:

- Do not begin Stage 2 until all Stage 1 tests pass.
- After each task, run relevant tests and confirm pass before continuing.
- If you hit a decision not covered by the spec, stop and ask — do not assume.
- If a test fails, run `/spec amend §B` on the Phase D spec to log it before fixing.
- If the same bug class could recur, run `/spec amend §V` to make it an invariant.
- Never mock `@platform/db` in a test file under `tests/isolation/` — real Postgres only (this
  is the exact class of gap that caused B1 in the Phase C spec).
