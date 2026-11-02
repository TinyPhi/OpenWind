-- analytics: excluded (no new table -- a column grant only)
--
-- Multi-Org Sandbox System (docs/specs/multi-org-sandbox.md R13): the platform admin hands a
-- prospect a login link of the form /login?org=<slug>, so the dashboard has to read the sandbox's
-- slug.
--
-- platform_admin_role has column-scoped SELECT on `tenants` (0135, 0144, 0155; ADR-022 Decision 1)
-- and this adds exactly one more column: the slug, which is tenant metadata like the name (R2),
-- not business data. It still has no grant on config, plan, zitadel_org_id or any other column,
-- and no UPDATE on `tenants`. The slug is never changed after creation, so a link handed over
-- stays valid.
--
-- DOWN MIGRATION:
--   REVOKE SELECT (slug) ON tenants FROM platform_admin_role;

GRANT SELECT (slug) ON tenants TO platform_admin_role;
