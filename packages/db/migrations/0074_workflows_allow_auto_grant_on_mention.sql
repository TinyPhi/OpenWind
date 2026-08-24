-- analytics: excluded (no new table — column addition only)
--
-- ADR-012 Phase C, spec R5 / Round 7 GAP-03: when an API-submitted comment
-- @mentions someone with workflow-but-not-ticket access, the workflow needs
-- its own setting for whether that grants read-only access automatically
-- (ON) or creates an access-request instead (OFF). Defaults to false for
-- every workflow, existing and new — a single unauthorized read-grant on
-- even one sensitive ticket (HR complaint, security incident) is treated as
-- a real problem on its own, not just a volume concern (design doc §4.4).
--
-- Rollback:
--   ALTER TABLE workflows DROP COLUMN allow_auto_grant_on_mention;

ALTER TABLE workflows
  ADD COLUMN allow_auto_grant_on_mention boolean NOT NULL DEFAULT false;
