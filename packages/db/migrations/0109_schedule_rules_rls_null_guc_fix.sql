-- Down migration (rollback):
-- WARNING: this restores migration 0101's original policy shape below,
-- which is exactly the bug this migration exists to fix -- applying this
-- rollback re-breaks the temporal scheduler platform-wide (schedule_rules
-- becomes invisible to schedulerTick's cross-tenant due-rule poll and
-- claimRule's claim/advance, apps/worker/src/schedule-tick-worker.ts, the
-- moment the worker runs under the RLS-enforced app_user role -- see the
-- fix rationale further down this file). Do not apply this rollback
-- without also planning a re-fix.
-- DROP POLICY IF EXISTS "schedule_rules_tenant_rls" ON "schedule_rules";
-- CREATE POLICY "schedule_rules_tenant_rls" ON "schedule_rules"
--   FOR ALL
--   USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
--   WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Migration 0101 gave schedule_rules a bare "must match app.tenant_id" RLS
-- policy, the same shape migration 0049 (#305) originally gave
-- outbox_events/dead_letter_events before 0058 fixed it -- and it has the
-- exact same bug those tables had: schedule_rules is legitimately read AND
-- written with NO tenant context by code that batches across every tenant
-- in one query -- apps/worker/src/schedule-tick-worker.ts's schedulerTick
-- (the due-rule SELECT) and claimRule (the SELECT ... FOR UPDATE SKIP
-- LOCKED + next_fire_at UPDATE, both inside a plain db.transaction(), not
-- withTenantContext, by design -- see that file's own header comment:
-- "System-level poll, no tenant_id filter -- the worker legitimately
-- processes rules for every tenant in one pass"). Under the app_user role
-- (RLS-enforced, no BYPASSRLS), that poll returned zero rows for every
-- rule, every tick, regardless of how overdue it was -- the scheduler
-- could never fire anything (2026-09-22 incident: verified directly, the
-- same due-rule query run as app_user returned 0 rows for a rule that was
-- objectively due; running it as an RLS-exempt role found it immediately).
--
-- On top of the base bug, 0058's own fix rationale applies identically here:
-- once ANY session on a pgbouncer-pooled connection has ever called
-- set_config('app.tenant_id', <realTenantId>, true) -- i.e. once, by
-- anything, anywhere, via withTenantContext -- Postgres permanently
-- registers app.tenant_id as a "placeholder" custom GUC for that backend's
-- remaining lifetime; current_setting('app.tenant_id', true) then returns
-- '' (empty string), not NULL, on every later transaction that doesn't
-- explicitly reset it. A fix that only handled the NULL case would still
-- break the instant any tenant-scoped query had ever run on the same
-- pooled connection -- both the NULL and '' cases must be exempted.
--
-- Fix: give schedule_rules the identical "no tenant context = system/batch
-- access" exemption 0058 gave outbox_events/dead_letter_events. Tenant
-- isolation is unchanged for any session that DOES have a real, non-empty
-- tenant_id set -- the match is still required whenever app.tenant_id is
-- non-empty; this only restores the batch/system access path a worker
-- legitimately needs.
--
-- The "tenant_id = current_setting(...)::uuid" branch must itself never be
-- able to receive '' as input to the cast -- NOT just be logically
-- short-circuited by the OR (the query planner can evaluate an OR branch's
-- cast eagerly to build a scan bound, independent of row-level
-- short-circuiting). NULLIF(..., '') guards the value fed into the cast
-- directly: always either a real UUID string or NULL, and NULL::text::uuid
-- is always safe (yields NULL, never throws).

DROP POLICY IF EXISTS "schedule_rules_tenant_rls" ON "schedule_rules";
CREATE POLICY "schedule_rules_tenant_rls" ON "schedule_rules"
  FOR ALL
  -- Three conditions, one concept: "match if scoped, allow if not scoped."
  -- 1) tenant_id = NULLIF(...)::uuid   -- real tenant_id set: match required.
  -- 2) current_setting(...) IS NULL    -- GUC never touched on this backend.
  -- 3) current_setting(...) = ''       -- GUC touched before, now a
  --    placeholder (the pgbouncer/set_config quirk explained above). Do not
  --    remove condition 2 or 3 as "redundant" with the other -- a given
  --    backend is in exactly one of those two states depending on its
  --    history, never both, and NULLIF alone (condition 1) only prevents the
  --    ::uuid cast from throwing; it does NOT grant batch access on its own.
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.tenant_id', true) IS NULL
    OR current_setting('app.tenant_id', true) = ''
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR current_setting('app.tenant_id', true) IS NULL
    OR current_setting('app.tenant_id', true) = ''
  );
