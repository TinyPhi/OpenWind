-- Down migration (rollback):
-- WARNING: this restores the 0049 policy shape below,
-- which contains the exact empty-string-cast bug this migration exists to
-- fix — applying this rollback re-breaks outbox/dead-letter delivery
-- platform-wide the moment any pgbouncer-pooled connection has ever touched
-- a real tenant context (see the fix rationale further down this file). Do
-- not apply this rollback without also planning a re-fix; to fully revert
-- instead of reintroducing the bug, run 0049's own down migration (DISABLE
-- ROW LEVEL SECURITY on these two tables), matching pre-0049/post-0006
-- behavior.
-- DROP POLICY IF EXISTS "outbox_events_tenant_isolation" ON "outbox_events";
-- CREATE POLICY "outbox_events_tenant_isolation"
--   ON "outbox_events"
--   FOR ALL
--   USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
--   WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
-- DROP POLICY IF EXISTS "dead_letter_events_tenant_isolation" ON "dead_letter_events";
-- CREATE POLICY "dead_letter_events_tenant_isolation"
--   ON "dead_letter_events"
--   FOR ALL
--   USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
--   WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Migration 0049 (#305) added RLS back to these two internal bus tables for
-- defense-in-depth, using a bare `current_setting('app.tenant_id', true)::uuid`
-- cast. This silently reintroduced exactly the problem migration 0006 disabled
-- RLS on these tables to avoid: both tables are intentionally read/written
-- with NO tenant context by code that legitimately batches across all tenants
-- — apps/worker/src/outbox-poller.ts, apps/worker/src/notification-poller.ts
-- (SELECT + UPDATE across every tenant's rows in one query), and
-- apps/worker/src/notification-outbound-worker.ts's system.error insert on a
-- permanently-failed outbound handoff (its own comment already documents
-- relying on 0006's "RLS disabled by design" — 0049 broke that INSERT too,
-- independent of the bug below, since `tenant_id = NULL::uuid` is NULL, which
-- WITH CHECK treats as a rejection).
--
-- On top of that, once ANY session on a pgbouncer-transaction-pooled
-- connection has ever called set_config('app.tenant_id', <realTenantId>, true)
-- — i.e. once, by anything, anywhere, via withTenantContext — Postgres
-- permanently registers app.tenant_id as a "placeholder" custom GUC for the
-- remaining lifetime of that backend process. After that point,
-- current_setting('app.tenant_id', true) returns '' (empty string), not NULL,
-- for every later transaction on that same connection that doesn't explicitly
-- set it again — neither DISCARD ALL nor a plain ROLLBACK clears this back to
-- NULL, only a brand-new backend process would. So once any pgbouncer-pooled
-- connection had ever been touched by a real tenant context, the pollers'
-- no-context queries started throwing `invalid input syntax for type uuid: ""`
-- instead of the `NULL::uuid` comparison they'd have hit pre-0049 — breaking
-- outbox delivery platform-wide (entity.assigned/SLA-breach notifications
-- included, not just the ticket-live-updates feature that surfaced this).
--
-- Fix: restore the "no tenant context = system/batch access" exemption these
-- two tables need (matching 0006's original design), covering both the NULL
-- case (a connection that's never touched the GUC) and the ''-placeholder
-- case (one that has). Tenant isolation is unchanged for any session that
-- DOES have a real, non-empty tenant_id set — the match is still required
-- whenever app.tenant_id is non-empty, so this does not weaken isolation for
-- any tenant-scoped caller, only restores the batch/system access path.
--
-- The `tenant_id = current_setting(...)::uuid` branch must itself never be
-- able to receive '' as input to the cast — NOT just be logically
-- short-circuited by the OR. The query planner can choose a plan (e.g. an
-- index scan on tenant_id) that evaluates an OR branch's cast eagerly, up
-- front, to build a scan bound, independent of whether row-level evaluation
-- would have short-circuited that branch — so `current_setting(...) = ''` as
-- a separate earlier OR branch does NOT prevent the later `::uuid` cast from
-- still throwing when eagerly evaluated. NULLIF(..., '') guards the value
-- fed into the cast directly: it's always either a real UUID string or NULL,
-- and casting NULL::text to uuid is always safe (yields NULL, never throws),
-- regardless of evaluation order.

DROP POLICY IF EXISTS "outbox_events_tenant_isolation" ON "outbox_events";
CREATE POLICY "outbox_events_tenant_isolation"
  ON "outbox_events"
  FOR ALL
  -- Three conditions, one concept: "match if scoped, allow if not scoped."
  -- 1) tenant_id = NULLIF(...)::uuid   — real tenant_id set: match required.
  -- 2) current_setting(...) IS NULL    — GUC never touched on this backend.
  -- 3) current_setting(...) = ''       — GUC touched before, now a
  --    placeholder (the pgbouncer/set_config quirk explained above). Do not
  --    remove condition 2 or 3 as "redundant" with the other — a given
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

DROP POLICY IF EXISTS "dead_letter_events_tenant_isolation" ON "dead_letter_events";
CREATE POLICY "dead_letter_events_tenant_isolation"
  ON "dead_letter_events"
  FOR ALL
  -- Three conditions, one concept: "match if scoped, allow if not scoped."
  -- 1) tenant_id = NULLIF(...)::uuid   — real tenant_id set: match required.
  -- 2) current_setting(...) IS NULL    — GUC never touched on this backend.
  -- 3) current_setting(...) = ''       — GUC touched before, now a
  --    placeholder (the pgbouncer/set_config quirk explained above). Do not
  --    remove condition 2 or 3 as "redundant" with the other — a given
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
