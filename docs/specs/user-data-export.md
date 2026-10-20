# User data export (GDPR Art. 15 / 20, #642)

status: in-progress
created: 2026-10-20
updated: 2026-10-20

Related: ADR-015, ADR-001, [gdpr-erasure-coverage](gdpr-erasure-coverage.md), [retention-classes](retention-classes.md).
No new ADR: ADR-015 covers the area and the decisions below were approved by the owner on #642.

## Goal

An admin can produce, for one user in their tenant, a JSON file of the personal data OpenWind stores
about that user. The file is fetched once through an admin-only route and deleted after a few days.

## Flow

1. `POST /users/:userId/export` (admin only, rate limited like entity exports). The user must have a
   `tenant_users` row in the caller's tenant, else 404, so another tenant's user id is
   indistinguishable from a missing one. Writes `export.requested`
   (`resource_type = user_data_export`, `resource_id` = the export's uuid, metadata: job id, subject
   id, format) then enqueues a `kind: "user_data"` job on the existing `export` queue. Returns 202
   `{ data: { jobId } }`. The job id is `userdata-<uuid>`.
2. The worker (`apps/worker/src/user-data-export.ts`) runs `collectUserDataBundle`
   (`packages/entity-engine/src/user-data-export.ts`) in one `withTenantContext` transaction, saves
   JSON with `saveExport(..., "json")`, and writes `export.completed` or `export.failed`. Bundle
   contents are never logged or audited.
3. `GET /users/:userId/export/:jobId/download` (admin only) returns pending (202), failed, or
   `downloadUrl`; with `?file=1` it streams the file. It 404s unless the job is a `user_data` job of
   this tenant for this user (a same-tenant, wrong-user request is audited as
   `export.download_denied`). `export.downloaded` is written before any bytes leave (fail closed). Responses carry `Cache-Control: no-store` and never a filesystem path.
4. `GET /exports/:jobId/download` (agents can reach it) answers 404 for any `user_data` job and writes
   `export.download_denied`. This is the main security property: an agent can never fetch a data
   subject's file.

No new audit actions, so no `audit_log_action_check` migration. `admin_audit_log.resource_id` is a
uuid column, which is why the audit entries use the export uuid, not the job id.

## Bundle

`{ metadata, data }`. Metadata: schema version, tenant, subject, `generatedAt`, `availableUntil`,
`rowLimit`, `includeAudit`, `truncated` (sections cut at the row limit), `exclusions` (what is left
out, and why). Each section is a per-table allow-list of columns, so a secret cannot appear by being
added to a table later. Every query has an explicit `tenant_id` filter. `saved_views` is read inside a
savepoint with `app.user_id` set to the subject, the same technique as erasure.

Collected (rows where the subject is the user column): `tenant_users`, `saved_views`,
`notification_recipients` (+ the `notifications` they point at), `ticket_alerts` (created),
`access_requests`, `api_keys` (metadata), `entity_instances` (created, assigned, origin performer;
`__accessUsers` removed because it lists other people), `entity_instance_tags`, `workflows`,
`workflow_events` (actor or origin performer, which includes comments they wrote, as-is),
`attachments` and `files` (metadata manifest, no bytes, no storage keys), `idempotency_keys`
(metadata), `connector_credentials` (disabled-by metadata only), `labels`, `ticket_labels`,
`notification_policies`, `teams`, `services`, `on_call_schedules`, `schedule_rules`, `org_employees`,
`org_directory_sync_runs`, and `admin_audit_log` (actor or acting person; `metadata` but not the
before/after snapshots, which describe resources others may have written) when
`USER_EXPORT_INCLUDE_AUDIT=true`.

Excluded: records written by others that merely mention the subject, the recipient list on someone
else's alert (`ticket_alerts.recipients_snapshot`), the live Zitadel profile, file bytes, and secrets
(`key_hash*`, connector `secrets` and `cursor_state`, `upload_token_hash`, `storage_key`,
idempotency `response_body`/`content_hash`). Tickets whose custom user-reference field points at the
subject are not included unless the subject created or is assigned to them.

Known limits: `workflow_events.event_type` is not in the Drizzle schema, so the bundle does not carry
it (comments are identifiable by `comment`). A user with no `tenant_users` row (never signed in) gets
404 even if other rows reference them.

## Configuration (validated env, `@platform/config`)

| Variable                    | Default | Meaning                                                                    |
| --------------------------- | ------- | -------------------------------------------------------------------------- |
| `USER_EXPORT_TTL_DAYS`      | 7       | 1-30. How long the file is downloadable and kept.                          |
| `USER_EXPORT_ROW_LIMIT`     | 10000   | 100-100000 per table. Truncation is listed in `metadata.truncated`.        |
| `USER_EXPORT_INCLUDE_AUDIT` | true    | Strict `true`/`false`. When false, `metadata.exclusions.auditLog` says so. |

## Expiry

The 7-day window is enforced three ways. The job is enqueued with
`removeOnComplete: { age: TTL }`, so the record the download route authorises against lives as long as
the file (the worker default of one hour would otherwise make the file undownloadable after an hour).
The download route reports `EXPORT_EXPIRED` once `finishedOn` is older than the TTL. And the daily
04:00 retention sweep (`retention-archival.ts`) calls `deleteExpiredUserDataExports` for every active
tenant, which deletes `userdata-*.json` files older than the TTL by modification time. That call runs
before the retention-hold check: a hold keeps records, not transient copies of personal data. No
export-file cleanup existed before this; entity exports are not swept by this change. A file can
therefore sit on disk up to one sweep interval past the TTL but cannot be downloaded.

## Tests

- Unit: collector (`user-data-export.test.ts`, entity-engine), routes (`user-export.test.ts`),
  worker (`user-data-export.test.ts`), `download.test.ts` (agent refused), files (json format, expiry
  sweep), config, retention-archival.
- `tests/isolation/user-data-export-coverage-guard.isolation.test.ts`: every column in the erasure
  inventory (handled and exempt) is collected or excluded with a reason, and still exists.
- `tests/isolation/user-data-export.isolation.test.ts`: real Postgres as `app_user`; collector scope,
  no other-tenant rows, no secret values, GUC restored; another tenant's admin gets 404; an agent
  cannot download (entity-export route 404 + audited, admin route 403).

## Not done

Zipping attachment bytes, CSV/other formats, the live Zitadel profile, an admin-ui button, a
user-self-service request path, and sweeping entity export files.
