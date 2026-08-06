-- down:
--   DROP INDEX IF EXISTS workflow_transitions_workflow_sort_idx;
--   ALTER TABLE workflow_transitions DROP COLUMN IF EXISTS sort_order;

-- Actions tab previously ordered transitions by ORDER BY id — id is a random
-- UUID, so the list did not reflect creation order (most-recently-added rows
-- appeared arbitrarily, not at the end). GENERATED ALWAYS AS IDENTITY backfills
-- existing rows in physical (ctid) order, which for pre-existing data
-- approximates original insertion order, and gives every future insert a
-- strictly increasing value.
ALTER TABLE workflow_transitions
  ADD COLUMN sort_order INTEGER GENERATED ALWAYS AS IDENTITY;

CREATE INDEX workflow_transitions_workflow_sort_idx
  ON workflow_transitions (workflow_id, sort_order);
