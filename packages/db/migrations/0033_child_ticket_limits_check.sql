-- analytics: excluded (operational config, no analytics value)
-- down:
--   ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_max_child_depth_check;
--   ALTER TABLE workflows DROP CONSTRAINT IF EXISTS workflows_max_children_per_parent_check;

-- IMP-11: a negative max_child_depth bypassed the `=== 0` disabled sentinel
-- in createChildRelation and triggered CHILD_DEPTH_EXCEEDED immediately on
-- every create attempt, with a message that reads as "children are enabled
-- but something else is wrong" rather than "this value is invalid".
ALTER TABLE workflows
  ADD CONSTRAINT workflows_max_child_depth_check CHECK (max_child_depth >= 0),
  ADD CONSTRAINT workflows_max_children_per_parent_check CHECK (max_children_per_parent >= 1);
