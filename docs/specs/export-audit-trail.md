# Export audit trail (#638)

> Every entity-list export, sync or async, leaves an audit record of who exported what, how
> many rows, in which format, and whether PII/financial fields were included. That includes
> exports that fail.

status: implemented
created: 2026-09-27
updated: 2026-09-27

---

## §G Goal

`GET /entity-types/:id/export` (`apps/api/src/routes/entity-types/export.ts`) and the async
worker (`apps/worker/src/export-worker.ts`) write no audit entries today. An agent or admin can
pull up to 10,000 rows, including PII and financial fields for `PII_EXPORT_ROLES`, with no
trace. That is a gap for Art. 5(2) accountability and for incident investigation.

## §C Constraints

| constraint      | value                                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vocabulary      | `admin_audit_log.action` is a closed CHECK list. A new migration re-creates `audit_log_action_check` with every existing action plus `export.requested`, `export.completed`, `export.failed`, and `AuditAction` in `packages/audit` gains the same three, in the same commit (0077 rule) |
| migration order | PR #681 (#635) adds `0126` (renumbered from 0125 after #685 took it on main). This one is `0127` and **must merge after #681**. The migrator skips a migration whose `when` is older than the newest applied one, so out-of-order merges silently drop #681's grants                     |
| fail-closed     | `export.requested` is written **before** any data leaves: before rendering on the sync path, before enqueueing on the async path. If the audit write fails, the export fails                                                                                                             |
| async job id    | pre-generated (`randomUUID()`) and passed to `exportQueue.add(..., { jobId })`, so the request entry can carry it                                                                                                                                                                        |
| resource        | `resourceType: "entity_type"`, `resourceId: entityTypeId`, `actorType: "user"`, `actorId`: the requester                                                                                                                                                                                 |
| no field values | metadata holds counts and settings only, never row data                                                                                                                                                                                                                                  |
| writes          | through `writeAuditEntry` inside `withTenantContext` (`app_user` has INSERT on `admin_audit_log`)                                                                                                                                                                                        |
| out of scope    | auditing the download of a finished async file (`/exports/:jobId/download` returning the URL); rejected requests (404 unknown type, 400 `EXPORT_TOO_LARGE`), which disclose no data                                                                                                      |

## §I Interfaces

| action             | written by                                               | metadata                                                                                       |
| ------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `export.requested` | route, both paths, before data leaves                    | `format`, `filters`, `includePii`, `rowCount`, `mode: "sync" \| "async"`, `jobId` (async only) |
| `export.completed` | route after a successful sync render; worker on success  | `format`, `rowCount`, `includePii`, `mode`, `jobId` (async)                                    |
| `export.failed`    | route on a sync render error; worker when the job throws | `format`, `mode`, `jobId` (async), `error` (code or message, no row data)                      |

`includePii` is true when the requester held a `PII_EXPORT_ROLES` role at request time. For the
worker it is recomputed from `requestedByRoles`, the same way the worker already decides which
columns to include.

## §R Requirements

- R1: Every export that proceeds writes `export.requested` before any data is rendered or queued.
- R2: A successful sync export writes `export.completed`, and a sync render error writes
  `export.failed` and still returns an error.
- R3: The async worker writes `export.completed` on success and `export.failed` when the job
  throws, then rethrows so BullMQ's failure handling is unchanged.
- R4: Every entry records `includePii` accurately.
- R5: The CHECK constraint accepts the three new actions and still rejects unknown ones.
- R6: Existing export tests assert the audit entries (issue AC).

## §V Invariants

- V1: no audit write, no export (sync and async).
- V2: audit metadata never contains exported field values.

## §T Tasks

| id  | task                                                                                                                                      | req        | status |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| T1  | Migration 0127 + `AuditAction` values                                                                                                     | R5         | done   |
| T2  | Route: requested/completed/failed on both paths, pre-generated job id, fail-closed                                                        | R1, R2, R4 | done   |
| T3  | Worker: completed/failed around the processor, rethrow                                                                                    | R3, R4     | done   |
| T4  | Route unit tests (`export.test.ts`) and worker processor tests assert the entries; isolation test that real rows land and the CHECK holds | R1–R6      | done   |
| T5  | Docs: week-log; note the #681 merge-order dependency in the PR                                                                            | —          | done   |

## §B Bugs / Backprop Log

- **B1 — deactivated-tenant jobs.** The worker returns `error: "TENANT_DEACTIVATED"` without
  throwing. `processExportJob` audits any result carrying `error` as `export.failed`, not
  `export.completed`.
- **B2 — worker audit of a failure is best-effort.** If writing `export.failed` itself fails, the
  worker logs that and rethrows the _original_ error, so BullMQ's retry and failure handling sees
  the real cause. On the request side, an audit failure fails the request (V1).
- **B3 — audit's exhaustive action maps.** `packages/audit/src/outcome.ts` and `request-kind.ts`
  each hold a `Record<AuditAction, true>` that must list every action. The first full typecheck
  caught the three new ones missing. They are classified `allowed` (no export denial is ever
  audited) and `read`.
- **B4 (security review) — no user ids in metadata.** `assignedTo` is a user id, and tenant-purge
  anonymization rewrites only `actor_id` / `acting_person_id`, never `metadata`. The audit entry
  records `filters.assignedToFilter: true` instead of the id.
- **B5 (security review) — bounded `state`.** The query param is now `max(128)` and
  `[A-Za-z0-9_-]`, so it can't write arbitrary text into audit rows.
- **B6 (security review) — cross-tenant test.** It now reads `admin_audit_log` as the other
  tenant under RLS, rather than through an explicit tenant filter.
- **B7 (PR #687 review).** The `error` field now uses domain codes everywhere (`RENDER_FAILED`,
  `ENQUEUE_FAILED`, `JOB_FAILED`) rather than JS class names, and the enqueue-failure entry
  carries `rowCount`. Filed as follow-ups: rate-limiting the export endpoint (ADR-013), and
  auditing the async file download.
- **Structure:** the worker's inline processor was extracted as `processExportJob` so its audit
  behaviour is unit-testable. `Worker` now calls it. Nothing else about the job changed.
