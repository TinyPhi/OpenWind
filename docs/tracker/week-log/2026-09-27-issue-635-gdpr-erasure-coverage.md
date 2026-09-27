## 2026-09-27 — #635 GDPR erasure coverage (tenant purge + per-user erasure)

**Session type:** Bug fix, worker + api + one grants migration
**Branch:** `fix/PLAT-635-gdpr-erasure-coverage`
**Spec:** `docs/specs/gdpr-erasure-coverage.md` / `-tasks.md`

### What was actually broken (worse than the issue said)

- **Tenant purge failed outright** for any tenant with an attachment, alert, access request,
  label, tag or schedule rule. Its first delete (`files`) violated `attachments_files_id_fkey`,
  and later deletes hit `NO ACTION`/`RESTRICT` FKs. The whole transaction rolled back on every
  retry.
- **Per-user erasure failed every time.** It deletes `ticket_alerts`/`access_requests` as
  `app_user`, which had no DELETE grant, so it hit `permission denied`. It rolled back before
  the Zitadel delete ran. The existing isolation test copied five of its statements instead of
  calling it, so it never noticed.
- **`saved_views` were silently kept.** Their RLS policy requires `user_id = app.user_id`, and
  the erasure runs as the admin.
- **15 tenant tables were never purged.** That's the issue's 14 plus `entity_instance_tags`,
  which landed after the audit. About 15 user-reference columns were never scrubbed.

### Done

- `tenant-purge.ts`:
  - FK-safe order with all 15 tables.
  - Privileged pre-step for `schedule_executions` (kept append-only) and `saved_views`.
  - Exported `PURGED_TENANT_TABLES` / `ERASURE_EXEMPT_TABLES` (audit log anonymized; rollup and
    usage metering kept).
- Per-user erasure extracted into `apps/api/src/services/user-erasure.ts`, which the route
  calls. It covers every user-reference column:
  - On-call shifts where the user is primary are deleted.
  - `origin_*` is redacted (all-or-nothing CHECK).
  - `__accessUsers` grants and `recipients_snapshot` entries are removed.
  - `schedule_rules` creators are redacted (ADR-017 inactive-creator path).
- Migration 0126 (renumbered from 0125 after #685 took that number on main):
  - `GRANT DELETE` on `ticket_alerts`/`access_requests`.
  - Column-level `UPDATE (created_by)` on `entity_instance_tags`.
- Drift guards read `information_schema` and fail CI naming any uncovered tenant table or
  user-reference column. Proved by adding a probe table: both guards failed, naming it.
- `db-conventions.md`: the same-PR rule plus a checklist line.

### Review

A medium code review and a security pass flagged the legacy `__accessUsers` array shape
(both, high), the `api_keys.rotated_from` self-FK, a scheduler race during purge, and the
erasure test not using the route's exact transaction context. All four are fixed with tests
(spec §B B7–B10). The security pass found nothing else: every statement is tenant-filtered and
parameterised, the new grants give no existing route new reach, and the `app.user_id` switch
is transaction-local.

### Verification

- New: `tenant-purge-full-coverage` (5), `user-erasure-coverage` (8), two guards (3 + 2); the
  route unit test was rewritten around the service (5). The existing purge suites stay green.
- All on freshly migrated databases. The long-lived local `platform_test` had drifted (0111
  failed to apply).

### Deferred

- User ids inside tenant-defined `user_ref` custom fields and free-text mentions in `fields`.
  Their location is per-entity-type schema, so this needs a field-type-aware pass (spec §B B5).
