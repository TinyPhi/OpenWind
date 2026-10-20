# 2026-10-20 — #642 GDPR Art. 15/20 data-subject export

- `POST /users/:userId/export` and an admin-only `GET /users/:userId/export/:jobId/download`
  (handlers in `routes/platform/user-export.ts`, mounted from `users.ts` beside the erasure route).
  New `user_data` job kind on the existing `export` queue; the entity-export payload is unchanged.
- The agent-reachable `/exports/:jobId/download` now 404s on any `user_data` job and audits
  `export.download_denied`.
- Collector in `packages/entity-engine/src/user-data-export.ts`: per-table column allow-lists, explicit
  `tenant_id` filters, `saved_views` behind the `app.user_id` savepoint. Placed in entity-engine because
  api and worker both need it and its rule is "db only"; it imports no engine code.
- `@platform/files`: `ExportFormat` gains `json`; `deleteExpiredUserDataExports` added.
- Expiry: no export-file cleanup existed. The job record is kept for the TTL (`removeOnComplete` at
  enqueue), the download route checks the TTL, and the daily retention sweep deletes expired
  `userdata-*.json` files (before the hold check).
- Env: `USER_EXPORT_TTL_DAYS=7`, `USER_EXPORT_ROW_LIMIT=10000`, `USER_EXPORT_INCLUDE_AUDIT=true`.
- No new audit actions, so no migration. `admin_audit_log.resource_id` is a uuid, so entries use the
  export uuid (job id is `userdata-<uuid>`).
- Found: `workflow_events.event_type` exists in the database but not in the Drizzle schema, so it is not
  in the bundle.
- `/security-review` is still pending (run by the orchestrator).
- Spec: `docs/specs/user-data-export.md`. Tests: collector, routes, worker, files, config, retention,
  plus two isolation files (coverage guard; tenant scoping and agent refusal).
