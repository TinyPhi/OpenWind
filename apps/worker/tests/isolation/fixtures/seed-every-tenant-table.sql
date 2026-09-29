-- Seeds one row into every tenant-scoped table for __TENANT__ (spec
-- docs/specs/gdpr-erasure-coverage.md R1). User-reference columns all use
-- __USER__ so the same fixture can back per-user erasure checks. Exempt from
-- this seed: installed_plugins (needs a real plugin schema — covered by
-- tenant-purge-plugin-data.isolation.test.ts).
DO $$
DECLARE
  t uuid := '__TENANT__';
  u text := '__USER__';
  et uuid; wf uuid; inst uuid; inst2 uuid; rule uuid; outbox uuid; f uuid;
  lbl uuid; team uuid; srule uuid; notif uuid; conn uuid; key uuid;
BEGIN
  -- connector_definitions is a platform catalog (no tenant_id); a fresh test
  -- database has none, so create a dedicated one idempotently.
  INSERT INTO connector_definitions (slug, name, version, category, allowed_hosts)
    VALUES ('test-erasure-coverage', 'Erasure coverage test', '0.0.1', 'other', ARRAY['example.invalid'])
    ON CONFLICT (slug) DO NOTHING;
  SELECT id INTO conn FROM connector_definitions WHERE slug = 'test-erasure-coverage';

  INSERT INTO entity_types (tenant_id, name, plural) VALUES (t, 'purge_cov_' || t, 'purge_covs') RETURNING id INTO et;
  INSERT INTO entity_fields (tenant_id, entity_type_id, name, label, field_type) VALUES (t, et, 'title', 'Title', 'text');
  INSERT INTO workflows (tenant_id, entity_type_id, name, initial_state, created_by) VALUES (t, et, 'Purge Cov', 'open', u) RETURNING id INTO wf;
  INSERT INTO workflow_states (tenant_id, workflow_id, name, label) VALUES (t, wf, 'open', 'Open'), (t, wf, 'done', 'Done');
  INSERT INTO workflow_transitions (tenant_id, workflow_id, from_state, to_state) VALUES (t, wf, 'open', 'done');
  INSERT INTO entity_instances (tenant_id, entity_type_id, workflow_id, current_state, fields, created_by, assigned_to, origin_mechanism, origin_oidc_client_id, origin_performer_user_id)
    VALUES (t, et, wf, 'open', '{"title":"a"}', u, u, 'api', 'client-x', u) RETURNING id INTO inst;
  INSERT INTO entity_instances (tenant_id, entity_type_id, fields, created_by) VALUES (t, et, '{"title":"b"}', u) RETURNING id INTO inst2;
  INSERT INTO entity_relations (tenant_id, from_instance_id, to_instance_id, relation_type) VALUES (t, inst, inst2, 'child');
  INSERT INTO workflow_events (tenant_id, instance_id, workflow_id, to_state, triggered_by, actor_id, origin_mechanism, origin_oidc_client_id, origin_performer_user_id) VALUES (t, inst, wf, 'open', u, u, 'api', 'client-x', u);

  INSERT INTO automation_rules (tenant_id, name, trigger_type, trigger_config, actions) VALUES (t, 'r', 'entity.created', '{}', '[]') RETURNING id INTO rule;
  INSERT INTO automation_executions (tenant_id, rule_id, trigger_event, status) VALUES (t, rule, '{}', 'success');
  INSERT INTO outbox_events (tenant_id, event_type, payload) VALUES (t, 'entity.created', '{}') RETURNING id INTO outbox;
  INSERT INTO dead_letter_events (tenant_id, event_type, payload, error, attempt_count, original_event_id, rule_id) VALUES (t, 'entity.created', '{}', 'x', 1, outbox, rule);

  INSERT INTO files (tenant_id, module_slug, original_name, storage_key, mime_type, size_bytes, uploaded_by) VALUES (t, 'm', 'a.txt', t || '/a', 'text/plain', 1, u) RETURNING id INTO f;
  INSERT INTO attachments (tenant_id, uploaded_by, acting_person_id, declared_filename, declared_size_bytes, declared_mime_type, upload_token_hash, upload_expires_at, files_id)
    VALUES (t, u, u, 'a.txt', 1, 'text/plain', 'h-' || t, now() + interval '1 day', f);

  INSERT INTO api_keys (tenant_id, name, key_hash, created_by) VALUES (t, 'k', 'hash-' || t, u) RETURNING id INTO key;
  INSERT INTO idempotency_keys (tenant_id, api_key_id, acting_person_id, idempotency_key, content_hash, response_status, response_body, expires_at)
    VALUES (t, key, u, 'idem', 'c', 200, '{}', now() + interval '1 day');
  INSERT INTO connector_credentials (tenant_id, connector_id, disabled_by) VALUES (t, conn, u);
  INSERT INTO connector_delivery_attempts (tenant_id, delivery_id, status, attempt_number, connector_id) VALUES (t, gen_random_uuid(), 'success', 1, conn);
  INSERT INTO plugin_errors (tenant_id, kind, detail) VALUES (t, 'runtime_exception', '{}');

  INSERT INTO tenant_users (tenant_id, user_id) VALUES (t, u);
  INSERT INTO view_configs (tenant_id, entity_type_slug) VALUES (t, 'purge_cov');
  INSERT INTO saved_views (tenant_id, user_id, entity_type_id, name) VALUES (t, u, et, 'mine');
  INSERT INTO ticket_alerts (tenant_id, instance_id, created_by, note, fire_at, scope, recipients_snapshot) VALUES (t, inst, u, 'n', now(), 'me', jsonb_build_array(u));
  INSERT INTO access_requests (tenant_id, instance_id, requester_id, requested_level, resolved_by) VALUES (t, inst, u, 'read_only', u);

  INSERT INTO notifications (tenant_id, type, title, body) VALUES (t, 'automation.notify', 't', 'b') RETURNING id INTO notif;
  INSERT INTO notification_recipients (tenant_id, notification_id, user_id) VALUES (t, notif, u);

  INSERT INTO entity_instance_tags (tenant_id, entity_instance_id, tag_text, created_by) VALUES (t, inst, 'vip', u);

  INSERT INTO labels (tenant_id, name, color, created_by) VALUES (t, 'l', '#000000', u) RETURNING id INTO lbl;
  INSERT INTO ticket_labels (tenant_id, ticket_instance_id, label_id, assigned_by) VALUES (t, inst, lbl, u);

  INSERT INTO teams (tenant_id, name, created_by) VALUES (t, 'team', u) RETURNING id INTO team;
  INSERT INTO services (tenant_id, name, created_by) VALUES (t, 'svc', u);
  INSERT INTO on_call_schedules (tenant_id, team_id, label, starts_at, ends_at, primary_user_id, backup_user_id, escalation_manager_user_id, created_by)
    VALUES (t, team, 'week', now(), now() + interval '7 days', u, u, u, u);
  INSERT INTO notification_policies (tenant_id, severity, channels, created_by) VALUES (t, 'high', ARRAY['email'], u);

  INSERT INTO schedule_rules (tenant_id, name, cron_expr, entity_type_id, workflow_id, template, created_by)
    VALUES (t, 's', '0 9 * * 1', et, wf, '{"title":"x"}', u) RETURNING id INTO srule;
  INSERT INTO schedule_executions (tenant_id, rule_id, scheduled_at, status, entity_instance_id) VALUES (t, srule, now(), 'success', inst);

  INSERT INTO org_employees (tenant_id, user_id, name, title, department, email) VALUES (t, u, 'Org Cov', 'Engineer', 'engineering', 'org-cov@example.invalid');
  INSERT INTO org_directory_sync_runs (tenant_id, status, triggered_by) VALUES (t, 'completed', u);

  INSERT INTO admin_audit_log (tenant_id, actor_id, actor_type, resource_type, resource_id, action) VALUES (t, u, 'user', 'ticket', inst, 'created');
  INSERT INTO admin_audit_log_daily_rollup (tenant_id, day, resource_type, action) VALUES (t, current_date, 'ticket', 'created');
  INSERT INTO tenant_usage_daily (tenant_id, usage_date, metric, value) VALUES (t, current_date, 'api_calls', 1);
END $$;
