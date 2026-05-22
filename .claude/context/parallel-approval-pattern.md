# Pattern: Parallel Approval

Referenced by: issues #3, #65. Used by: reimbursements module (multi-level approval).

This pattern implements multi-approver workflows (quorum, unanimous, sequential)
using **no special engine code** — only entity types, automation rules, and a
parent workflow transition.

---

## How it works

1. Parent entity (e.g. `expense_claim`) has a workflow state `pending_approval`
2. When the claim enters `pending_approval`, an automation rule fires:
   - Creates one `approval` sub-entity per required approver
   - Sets each approval's `status = pending`, `approver_id = <user>`, `parent_id = <claim_id>`
3. Each approver acts on their `approval` entity (transition: `pending → approved` or `pending → rejected`)
4. An automation rule monitors the `approval.transitioned` event and checks quorum:
   - On each approval transition, count approvals with `status = approved` vs total
   - If quorum met → transition parent claim to `approved`
   - If any rejection (unanimous mode) → transition parent to `rejected`
5. The parent claim transition is executed via the automation engine's `transition` action

## Quorum check (condition tree)

The automation rule condition is a JSON rule tree evaluated by the condition evaluator.
For a 2-of-3 quorum, the automation rule action calls a script action that counts
`approval` entities related to the parent and checks the ratio.

**Prerequisite — N2 fix from PR #49:** `evaluateConditionTree` currently receives `{}`
as context for non-`entity.created` events. A quorum condition on `approval.transitioned`
will always evaluate against empty context and silently fail (quorum never detected).
The automation quorum rule cannot work until N2 is resolved. Do not implement quorum
automation until that fix is merged.

## Stuck-instance edge cases (issue #65)

Known edge cases that need resolution before Phase 2 pilot:

| Case                                                        | Risk                                | Resolution status           |
| ----------------------------------------------------------- | ----------------------------------- | --------------------------- |
| Approver deactivated mid-flow                               | Approval stuck in `pending` forever | Open — need policy decision |
| Quorum denominator changes (approver added/removed)         | Quorum count wrong                  | Open — need policy decision |
| Parent entity deleted while approvals pending               | Orphaned approval sub-entities      | Open                        |
| All approvers reject but parent still in `pending_approval` | Stuck instance                      | Open                        |

**Do not implement parallel approval for the pilot until issue #65 is resolved.**
For the reimbursements module pilot, use sequential (single approver) approval first.

## Seed SQL shape

```sql
-- approval entity type
-- entity_types has no slug column; plural is NOT NULL
INSERT INTO entity_types (id, tenant_id, name, plural, allow_custom_fields)
VALUES (gen_random_uuid(), '{TENANT_ID}', 'Approval', 'Approvals', false);

-- entity_fields has no slug column; required column is is_required; label is NOT NULL
INSERT INTO entity_fields
  (id, tenant_id, entity_type_id, name, label, field_type, is_required, config)
VALUES
  (gen_random_uuid(), '{TENANT_ID}', <approval_type_id>,
   'status', 'Status', 'select', true,
   '{"options": ["pending","approved","rejected"]}'),
  (gen_random_uuid(), '{TENANT_ID}', <approval_type_id>,
   'approver_id', 'Approver', 'user_ref', true, '{}'),
  (gen_random_uuid(), '{TENANT_ID}', <approval_type_id>,
   'parent_id', 'Parent', 'entity_ref', true,
   '{"entity_type_slug": "expense_claim"}');
```
