-- modules/helpdesk/seed/001_entity_types.sql

-- Insert entity types idempotently
INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'ticket', 'Tickets', 'ticket', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'comment', 'Comments', 'comment', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'comment' AND tenant_id = '{TENANT_ID}'
);

INSERT INTO entity_types (id, tenant_id, name, plural, icon, module_id, allow_custom_fields)
SELECT gen_random_uuid(), '{TENANT_ID}', 'article', 'Articles', 'article', '{MODULE_ID}', true
WHERE NOT EXISTS (
  SELECT 1 FROM entity_types WHERE name = 'article' AND tenant_id = '{TENANT_ID}'
);

-- Insert fields for Ticket
--
-- severity (docs/specs/oncall-routing.md T5, R1, R2) -- system field for 3E
-- on-call routing. OPTIONAL (is_required false): a ticket without it
-- behaves exactly as before (R1's no-regression requirement).
--
-- severity vs priority (PR #585 review, G2 -- ADR-016 Decision 2): these
-- look interchangeable (both are select fields agents see on the same
-- ticket) but answer different questions. `priority` is workflow-facing --
-- how urgently should an agent work this ticket, set/changed by agents
-- during triage. `severity` is customer/business-impact-facing -- how
-- badly is this affecting the customer, and is the sole input to 3E's
-- on-call notification routing (a high-severity ticket pages on-call
-- regardless of its priority in the agent's queue). Do not conflate the
-- two or drop one in favor of the other when touching this field.
--
-- team_id/service_id are DELIBERATELY NOT seeded here yet. They were
-- originally planned for this same PR, but seeding them as field_type
-- 'entity_ref' would be actively broken: packages/entity-engine's
-- validateEntityRefs (called unconditionally by engine.ts for every
-- entity_ref field present in a create/update payload) only knows how to
-- resolve a ref against entity_instances -- but teams/services are plain
-- Drizzle tables (ADR-016 Decision 1), not entity_types rows. Because the
-- EXISTING generic entity create/update route already accepts arbitrary
-- fields (apps/api/src/routes/entities/create.ts's `fields: z.record(...)`,
-- validated dynamically against whatever entity_fields exist), this is not
-- a "Phase 2 will eventually expose it" gap -- it would be immediately
-- reachable the moment these two fields exist, incorrectly rejecting every
-- legitimate team_id/service_id as INVALID_REFERENCE.
--
-- Fixing this properly requires deciding where the shared cross-tenant
-- table-ref validation helper (packages/teams/src/cross-tenant-ref-
-- validator.ts's validateCrossTenantRefs, built for exactly this purpose
-- per R1d/T44) should live, since packages/entity-engine's dependency rule
-- (CLAUDE.md: "entity-engine -> db only") means entity-engine cannot import
-- packages/teams as currently structured. See open-questions.md for the
-- tracked follow-up -- team_id/service_id seeding is deferred to whichever
-- PR resolves that dependency-direction question and updates
-- validateEntityRefs' dispatch accordingly.
INSERT INTO entity_fields (entity_type_id, tenant_id, name, label, field_type, config, is_required, is_indexed, is_system, sort_order)
VALUES
  ((SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'title', 'Title', 'text', '{}'::jsonb, true, true, true, 1),
  ((SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'description', 'Description', 'textarea', '{}'::jsonb, false, false, true, 2),
  ((SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'priority', 'Priority', 'select', '{"options": ["low", "medium", "high", "urgent"]}'::jsonb, true, true, true, 3),
  ((SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'category', 'Category', 'select', '{"options": ["technical", "billing", "general"]}'::jsonb, true, true, true, 4),
  ((SELECT id FROM entity_types WHERE name = 'ticket' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'severity', 'Severity', 'select', '{"options": ["critical", "high", "medium", "low"]}'::jsonb, false, true, true, 5)
ON CONFLICT (entity_type_id, name) DO NOTHING;

-- Insert fields for Comment
INSERT INTO entity_fields (entity_type_id, tenant_id, name, label, field_type, config, is_required, is_indexed, is_system, sort_order)
VALUES
  ((SELECT id FROM entity_types WHERE name = 'comment' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'body', 'Body', 'textarea', '{}'::jsonb, true, false, true, 1),
  ((SELECT id FROM entity_types WHERE name = 'comment' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'ticket_id', 'Ticket', 'entity_ref', '{"target_entity_type": "ticket"}'::jsonb, true, true, true, 2)
ON CONFLICT (entity_type_id, name) DO NOTHING;

-- Insert fields for Article
INSERT INTO entity_fields (entity_type_id, tenant_id, name, label, field_type, config, is_required, is_indexed, is_system, sort_order)
VALUES
  ((SELECT id FROM entity_types WHERE name = 'article' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'title', 'Title', 'text', '{}'::jsonb, true, true, true, 1),
  ((SELECT id FROM entity_types WHERE name = 'article' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'body', 'Body', 'textarea', '{}'::jsonb, true, false, true, 2),
  ((SELECT id FROM entity_types WHERE name = 'article' AND tenant_id = '{TENANT_ID}'), '{TENANT_ID}', 'category', 'Category', 'text', '{}'::jsonb, false, true, true, 3)
ON CONFLICT (entity_type_id, name) DO NOTHING;
