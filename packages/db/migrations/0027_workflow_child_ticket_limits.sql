-- analytics: excluded (operational config, no analytics value)
-- down: ALTER TABLE workflows DROP COLUMN max_child_depth;
--       ALTER TABLE workflows DROP COLUMN max_children_per_parent;

ALTER TABLE workflows
  ADD COLUMN max_child_depth INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN max_children_per_parent INTEGER NOT NULL DEFAULT 10;
