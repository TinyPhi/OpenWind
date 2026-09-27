# GDPR Erasure Coverage — tenant purge + per-user erasure (#635)

> Fix both Article 17 erasure paths so they cover every tenant-scoped table and every
> user-reference column, make them actually succeed under `app_user`, and add a schema-driven
> guard so new tables can't drift out of coverage again.

status: implemented
created: 2026-09-27
updated: 2026-09-27

---

## §G Goal

A tenant purge leaves no row in any tenant-scoped table except the documented exemptions, and it
completes. A per-user erasure removes or redacts every reference to that user, and it completes.
A CI test fails the moment a new tenant table or user-reference column is added without being
wired into the right erasure path (or explicitly exempted with a reason).

## §F Findings (audit 2026-09-27; the issue's 2026-09-18 list understated this)

- **F1 — tenant purge fails outright for most real tenants.** `apps/worker/src/tenant-purge.ts`
  deletes `files` first, but `attachments → files` is `NO ACTION`. Also `ticket_alerts`,
  `access_requests`, `ticket_labels` and `schedule_executions → entity_instances` are `NO ACTION`,
  and `schedule_rules → workflows` is `RESTRICT`. Any such row raises an FK violation, the
  transaction rolls back, and BullMQ retries fail identically. Only the plugin-schema purge (its
  own connection) takes effect.
- **F2 — 14 tenant tables are not purged at all:** `ticket_alerts`, `access_requests`,
  `attachments`, `notifications`, `notification_recipients`, `saved_views`, `labels`,
  `ticket_labels`, `teams`, `services`, `on_call_schedules`, `notification_policies`,
  `schedule_rules`, `schedule_executions`.
- **F3 — per-user erasure fails every time.** `DELETE /users/:userId`
  (`apps/api/src/routes/platform/users.ts`) deletes from `ticket_alerts` and `access_requests`
  inside `withTenantContext` (`app_user`), but `app_user` has no `DELETE` on either table
  (migrations 0045, 0032). Verified: `permission denied for table ticket_alerts`. The transaction
  rolls back before Zitadel `deleteUser` runs, so nothing is erased. The isolation test
  (`gdpr-erasure.isolation.test.ts`) re-implements five steps inline instead of calling the route,
  so it never exercised these statements.
- **F4 — `saved_views` is invisible to both paths.** Its RLS policy requires
  `user_id = app.user_id`. Per-user erasure runs with the _admin's_ `app.user_id`, so the target's
  saved views match zero rows and are silently kept. Tenant purge sets no `app.user_id`.
- **F5 — per-user erasure misses user-reference columns:** `entity_instances.origin_performer_user_id`,
  `workflow_events.origin_performer_user_id`, `ticket_alerts.recipients_snapshot` (jsonb array
  entries), `files.uploaded_by`, `connector_credentials.disabled_by`, `labels.created_by`,
  `ticket_labels.assigned_by`, `notification_policies.created_by`, `teams.created_by`,
  `services.created_by`, `on_call_schedules.{primary_user_id, backup_user_id,
escalation_manager_user_id, created_by}`, `schedule_rules.created_by`.

## §C Constraints

| constraint         | value                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pattern refs       | ADR-015 (FK-safe, idempotent purge; audit log retained); `docs/specs/third-party-api-phase-g-hardening.md` R8–R10 and its rule that "a new PII-bearing table is never added without also adding it to the purge path in the same change"                                                               |
| tenant isolation   | every delete/update keeps an explicit `tenant_id` filter; RLS stays enabled                                                                                                                                                                                                                            |
| append-only tables | `schedule_executions` stays append-only for `app_user` (migration 0102 §V). Purge deletes it via the privileged `db` connection with an explicit tenant filter, as a pre-step before the main transaction — same precedent as `anonymizeAuditLogForTenant` and the plugin-schema pre-step              |
| grants             | migration 0125: `GRANT DELETE ON ticket_alerts, access_requests TO app_user`, plus column-level `GRANT UPDATE (created_by) ON entity_instance_tags` (see §B B2). These are ordinary mutable tenant tables whose RLS policies already cover all commands (`*`); the route already depends on this grant |
| saved_views RLS    | not relaxed. Per-user erasure sets `app.user_id` to the target (transaction-local `set_config`) just for the `saved_views` delete, then restores it. Tenant purge deletes `saved_views` in the privileged pre-step                                                                                     |
| on-call primary    | **decided 2026-09-27:** schedule rows where the erased user is `primary_user_id` are deleted (a shift slot is wholly that person's); `backup_user_id` / `escalation_manager_user_id` are nulled; `created_by` redacted                                                                                 |
| exemptions         | **decided 2026-09-27:** `admin_audit_log` (anonymized on purge, per R9), `admin_audit_log_daily_rollup` and `tenant_usage_daily` (counts only, no personal data; kept for metering). Recorded in the guard's exemption list with reasons                                                               |
| out of scope       | per-user erasure of `admin_audit_log` (kept on purpose, Art. 17(3)(b), unchanged); `platform_settings.updated_by` (not tenant-scoped); Superset cache/export volume (3G, not built); ADR changes                                                                                                       |

## §I Interfaces

**Tenant purge order** (`tenant-purge.ts`):

1. Plugin schemas (unchanged).
2. **Privileged pre-step** (`db`, explicit `tenant_id`): `schedule_executions`, `saved_views`.
3. **Main `withTenantContext` transaction**, children before parents:
   `notification_recipients` → `notifications` → `ticket_labels` → `labels` →
   `ticket_alerts` → `access_requests` → `attachments` → `files` → `schedule_rules` →
   `on_call_schedules` → `notification_policies` → `services` → `teams` → then the existing
   workflow/entity/automation/connector/user/plugin/idempotency deletes.
4. Audit anonymization, tombstone, `purge.completed` (unchanged).

The purge exports its covered-table list (`PURGED_TENANT_TABLES`) and an
`ERASURE_EXEMPT_TABLES` map (`table → reason`) for the guard.

**Per-user erasure:** each user-reference column is classified as delete-row, redact
(`'[REDACTED]'`), or null, following the route's existing rule. Delete where the row is wholly
the user's; redact or null where the row belongs to someone else. The route exports
`USER_REFERENCE_COLUMNS_HANDLED` (and exemptions with reasons) for the guard.

**Coverage guard:** a test reads `information_schema.columns`. It asserts that every
`public` table with `tenant_id` is in the purge list or the exempt list, and that every column
matching the user-reference naming convention (`created_by`, `*_user_id`, `assigned_to`,
`assigned_by`, `actor_id`, `acting_person_id`, `requester_id`, `resolved_by`, `revoked_by`,
`disabled_by`, `uploaded_by`, `triggered_by`, `updated_by`, `user_id`) is handled or exempt.

## §R Requirements

- R1: Tenant purge completes for a tenant with a row in **every** tenant table (including
  attachments, schedule rules/executions, labels, on-call schedules, saved views), and afterwards
  no non-exempt tenant table has a row for that tenant. It stays idempotent on retry.
- R2: Purge never touches another tenant's rows.
- R3: `DELETE /users/:userId` completes (no permission error) and leaves no reference to the
  target user in any handled column. Delete / redact / null follows §C and §I.
- R4: Per-user erasure removes the target's `saved_views` even when invoked by a different
  (admin) user, and never touches other users' saved views or other tenants' rows.
- R5: Coverage guard fails on an uncovered tenant table or user-reference column, and names it.
- R6: `db-conventions.md` states the rule: a new tenant table or user-reference column is wired
  into both erasure paths, or exempted with a reason, in the same PR. The guard enforces it.

## §V Invariants

- V1: explicit `tenant_id` filter on every erasure statement, privileged or not.
- V2: no RLS policy is relaxed and no append-only grant is widened.
- V3: erasure isolation tests call the real purge function and the real route handler, never a
  hand-copied subset of their statements (the F3 failure mode).

## §T Tasks

| id  | task                                                                                                                             | req        | status |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| T1  | Prove-it: worker isolation test seeds every tenant table, runs the real purge → fails today (FK)                                 | R1, R2, V3 | done   |
| T2  | Migration: `GRANT DELETE ON ticket_alerts, access_requests TO app_user` (+ analytics/rollback per db-conventions)                | R3         | done   |
| T3  | `tenant-purge.ts`: privileged pre-step + reordered main tx + 14 tables; export covered/exempt lists                              | R1, R2     | done   |
| T4  | Prove-it: api isolation test calls the real `DELETE /users/:userId` handler with rows in every user column → fails today (F3/F4) | R3, R4, V3 | done   |
| T5  | `users.ts` erasure: grant-dependent deletes, saved_views via target `app.user_id`, the 15 missing columns incl. jsonb snapshot   | R3, R4     | done   |
| T6  | Coverage guard test (tables + user columns) against `information_schema`                                                         | R5         | done   |
| T7  | `db-conventions.md` rule; tracker/week-log; `pending-review-findings` if anything is deferred                                    | R6         | done   |

## §B Bugs / Backprop Log

- **B1 — a 15th uncovered table.** `entity_instance_tags` (migration 0108, #659) landed after the
  audit. The seed-coverage check in `tenant-purge-full-coverage` caught it on a freshly migrated
  database. It is now purged, and its `created_by` is redacted on user erasure.
- **B2 — `entity_instance_tags` had no UPDATE grant.** Tags are add/remove only (0108 granted
  SELECT/INSERT/DELETE). Erasure must redact `created_by` on tags a user added to someone else's
  ticket, so 0125 grants **column-level** `UPDATE (created_by)`; `tag_text` stays immutable.
- **B3 — `origin_performer_user_id` can't be nulled.** CHECK `*_origin_all_or_nothing` requires
  all three `origin_*` columns set together, so the performer is redacted to `'[REDACTED]'`.
- **B4 — old attachments step over-redacted.** It set _both_ `uploaded_by` and
  `acting_person_id` to `[REDACTED]` when either matched, which erased another user's
  attribution. Now each column is redacted only when it is the target.
- **B5 — per-record grants.** `entity_instances.fields.__accessUsers` is keyed by user id, so
  erasure now removes the target's key. Deferred, not handled: user ids inside tenant-defined
  `user_ref` custom fields and free-text mentions in `fields`. Their location is schema-defined
  per entity type, not a fixed column; this needs a field-type-aware pass.
- **B6 — `schedule_rules.created_by` redacted.** Per ADR-017 Decision 5 (an inactive creator),
  the rule then logs `failed` executions until an admin reassigns the creator.
- **B7 (review) — legacy `__accessUsers` shape.** Older rows store it as `string[]`, and
  `#- ARRAY['__accessUsers', id]` throws on an array, which would roll back every erasure
  touching one. Now branches on `jsonb_typeof`. A legacy row is seeded in the isolation test.
- **B8 (review) — `api_keys.rotated_from` self-FK.** Deleting the target's key failed if
  someone else had rotated it. The pointer on the newer key is now cleared first.
- **B9 (review) — scheduler race during purge.** The pre-step archives the tenant's schedule
  rules before deleting executions, so the tick (active rules only) can't insert new ones
  ahead of the RESTRICT-FK rule delete. A tick already mid-flight converges on BullMQ retry.
- **B10 (review) — test context.** The erasure isolation test now runs under
  `withTenantContext` exactly as the route does (`app.user_id` unset), not with a user context.
- **Order note:** Phase 2's service was written before its isolation test (Phase 1 was test-first).
  F3 had already been reproduced directly (`permission denied for table ticket_alerts` as
  `app_user`), and every newly handled column fails the new test against the old statements.
- **Local-env note:** the long-lived local `platform_test` had drifted (107 applied entries from
  mixed branches; 0111 failed). All verification here ran on freshly migrated databases.
