-- Let Superset record what analysts query and export into the platform's own
-- audit store.
--
-- Stage 2 gives people the ability to run their own SQL and pull results out.
-- Superset keeps its own action log, but the spec is explicit that it is not an
-- audit trail: a Superset admin can edit or purge it, and it lives outside the
-- platform's retention and export guarantees
-- (docs/specs/superset-standalone-with-zitadel.md §C "audit trail", R7).
--
-- Two things are needed and neither exists yet.
--
-- 1. The action allowlist. `admin_audit_log.action` is constrained to a fixed
--    set, which is a good property — it keeps the log a closed vocabulary
--    rather than free text — so the reporting actions have to be added to it
--    rather than written around it.
--
-- 2. A way in for the reporting role. That role can read six tables and write
--    none, which is exactly right and leaves it unable to append its own audit
--    record. Rather than granting INSERT on the audit table — which would also
--    let it write records attributed to anyone, about anything — this exposes
--    one function that appends a single row with the action fixed to the
--    reporting vocabulary.
--
-- The function is SECURITY DEFINER so it runs as the owner, with search_path
-- pinned for the same reason as 0114: a definer function resolving names
-- through the caller's search_path can be made to run the caller's code as the
-- owner.
--
-- Rollback (fails if reporting.* rows already exist — delete or keep them
-- first, as with any allowlist narrowing):
--   DROP FUNCTION IF EXISTS public.record_reporting_audit(uuid, text, text, jsonb);
--   ALTER TABLE admin_audit_log DROP CONSTRAINT audit_log_action_check;
--   -- then re-add the constraint exactly as in 0103.

BEGIN;

ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;

ALTER TABLE admin_audit_log ADD CONSTRAINT audit_log_action_check CHECK (
    action = ANY (ARRAY[
        'created', 'updated', 'deleted', 'transitioned', 'restored',
        'purge.completed', 'purge.failed',
        'tag.resolved_existing_access', 'tag.auto_granted',
        'tag.access_request_created', 'tag.fallback', 'tag.resolution_failed',
        'tag.misuse_rate_capped',
        'attachment.quarantined', 'attachment.scan_failed',
        'transition.executed', 'transition.access_denied',
        'comment.created', 'comment.access_denied',
        'child.created', 'child.access_denied',
        'attachment.referenced', 'attachment.reference_denied',
        'ticket.viewed', 'ticket.view_denied', 'ticket.listed',
        'workflow.listed', 'workflow_fields.listed',
        'attachment.downloaded', 'attachment.download_denied',
        'oncall.auto_assigned', 'oncall.no_schedule',
        'oncall.skipped_explicit_assignee',
        'label.assigned', 'label.removed',
        'notification.dispatched', 'notification.channel_failed',
        'schedule.ticket_created', 'schedule.execution_failed',
        'schedule.execution_skipped', 'schedule.rule_paused',
        'schedule.rule_resumed', 'schedule.rule_archived',
        -- Stage 2 reporting. Queries and exports are recorded separately
        -- because they carry different risk: a query reads, an export removes
        -- data from the platform's control, and the spec asks for export
        -- volume to be answerable on its own.
        'reporting.query_executed',
        'reporting.exported'
    ])
);

-- One row per call, action constrained to the reporting vocabulary. A caller
-- cannot use this to forge a 'deleted' record against a ticket.
CREATE OR REPLACE FUNCTION public.record_reporting_audit(
    p_tenant_id uuid,
    p_actor_id  text,
    p_action    text,
    p_metadata  jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_action NOT IN (
        'reporting.query_executed',
        'reporting.exported'
    ) THEN
        RAISE EXCEPTION 'record_reporting_audit: unsupported action %', p_action;
    END IF;

    INSERT INTO admin_audit_log (
        tenant_id, actor_id, actor_type, resource_type, resource_id,
        action, metadata
    ) VALUES (
        p_tenant_id,
        p_actor_id,
        'user',
        'reporting',
        -- The audit table wants a resource UUID and a query has no durable id
        -- of its own, so each record gets its own. The useful identity of a
        -- query is its text and timing, which live in the metadata.
        gen_random_uuid(),
        p_action,
        COALESCE(p_metadata, '{}'::jsonb)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_reporting_audit(uuid, text, text, jsonb) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analytics_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.record_reporting_audit(uuid, text, text, jsonb) TO analytics_user';
  END IF;
END
$$;

COMMIT;
