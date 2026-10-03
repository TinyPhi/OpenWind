-- analytics: excluded (no new table — data-only update of automation_rules)
--
-- #684 part 2: retire the automation trigger types nothing emits. Rules saved
-- with them never fired.
--   workflow.entered_state -> workflow.transitioned, toState taken from toState
--                             or the wizard's old `state` key
--   field.changed          -> entity.updated, field taken from field or the
--                             wizard's old `fieldName` key
--   schedule.cron, connector.event -> disabled (no replacement event yet)
-- Empty-string values are dropped from converted configs. The API rejects all
-- four types from this release, and refuses to re-enable rules stored with them.
--
-- Must apply after 0131 (#759): the migrator skips a migration whose journal
-- timestamp is older than the newest one already applied.
--
-- Not automatically reversible: the original trigger_type and keys are not
-- kept. To roll back, restore automation_rules from a pre-deploy backup.
-- Converted rules start firing on their new trigger types once this applies.

UPDATE automation_rules r
SET trigger_type = 'workflow.transitioned',
    trigger_config = (
        SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
        FROM jsonb_each(
            (r.trigger_config - 'state' - 'toState' - 'fieldName')
            || CASE
                WHEN COALESCE(NULLIF(r.trigger_config->>'toState', ''),
                              NULLIF(r.trigger_config->>'state', '')) IS NULL
                    THEN '{}'::jsonb
                ELSE jsonb_build_object(
                    'toState',
                    COALESCE(NULLIF(r.trigger_config->>'toState', ''),
                             NULLIF(r.trigger_config->>'state', '')))
            END
        ) AS e
        WHERE e.value NOT IN ('""'::jsonb, 'null'::jsonb)
    ),
    updated_at = now()
WHERE r.trigger_type = 'workflow.entered_state'
  AND jsonb_typeof(r.trigger_config) = 'object';

UPDATE automation_rules r
SET trigger_type = 'entity.updated',
    trigger_config = (
        SELECT COALESCE(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
        FROM jsonb_each(
            (r.trigger_config - 'field' - 'fieldName')
            || CASE
                WHEN COALESCE(NULLIF(r.trigger_config->>'field', ''),
                              NULLIF(r.trigger_config->>'fieldName', '')) IS NULL
                    THEN '{}'::jsonb
                ELSE jsonb_build_object(
                    'field',
                    COALESCE(NULLIF(r.trigger_config->>'field', ''),
                             NULLIF(r.trigger_config->>'fieldName', '')))
            END
        ) AS e
        WHERE e.value NOT IN ('""'::jsonb, 'null'::jsonb)
    ),
    updated_at = now()
WHERE r.trigger_type = 'field.changed'
  AND jsonb_typeof(r.trigger_config) = 'object';

-- Anything still on a retired type (cron, connector, or a malformed config the
-- conversions above skipped) is disabled rather than deleted, so its
-- definition survives for an admin to re-create on a supported trigger.
UPDATE automation_rules
SET is_enabled = false,
    updated_at = now()
WHERE trigger_type IN ('workflow.entered_state', 'field.changed',
                       'schedule.cron', 'connector.event')
  AND is_enabled;
