# Automation trigger_config scoping (#678)

> Make the automation executor honour `automation_rules.trigger_config`, so a rule scoped to a
> workflow, state or entity type fires only for events that match that scope.

status: implemented
created: 2026-09-27
updated: 2026-09-27

---

## §G Goal

A rule fires only for events inside the scope its author chose. Today
`executeAutomationRules` (`packages/automation-engine/src/executor.ts`) selects rules by tenant +
`trigger_type` + `is_enabled` and evaluates `conditions` only; `trigger_config` is stored but never
read. Every wizard-built rule ("when a Purchase Order enters Approved → webhook") therefore fires on
**every** event of that trigger type in the tenant. Actions include `webhook` (outbound HTTP),
`transition` and `set_field`.

## §C Constraints

| constraint        | value                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| engine            | `packages/automation-engine` only (+ the sync-path event builder in `actions/transition.ts`); dependency rule unchanged (`db, workflow-engine, entity-engine, teams, audit`)                                                          |
| empty = any       | a missing key, `null` or `""` means "no restriction". `{}` keeps matching every event of the trigger type, which is what ~17 isolation tests and the resolve-oncall design rely on                                                    |
| unknown keys      | ignored (not a match failure), so unrecognised or future keys never silently disable a rule                                                                                                                                           |
| tenant isolation  | the entity-type-name lookup filters by `tenant_id` explicitly (plus RLS where run in tenant context)                                                                                                                                  |
| order of checks   | trigger_config scope is checked **before** conditions and before an `automation_executions` row is written, so out-of-scope rules leave no execution trail                                                                            |
| out of scope      | wizard/API key mismatches (`fieldName` vs `field`; `state` vs `toState` on `entered_state`), and trigger types with no emitter (`workflow.entered_state`, `field.changed`, `schedule.cron`, `connector.event`) — filed as a follow-up |
| no data migration | existing rows are not rewritten; the change narrows matching to what each rule's config already says                                                                                                                                  |

## §I Interfaces

**Scope keys per trigger type** (all optional; compared against the event payload):

| trigger_type                                                                                                                                | key            | event field                        | notes                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `workflow.transitioned`                                                                                                                     | `workflowId`   | `workflowId`                       | uuid                                                                                                                           |
|                                                                                                                                             | `fromState`    | `fromState`                        | state name                                                                                                                     |
|                                                                                                                                             | `toState`      | `toState`                          | state name                                                                                                                     |
| `workflow.sla_breached`                                                                                                                     | `workflowId`   | `workflowId`                       |                                                                                                                                |
|                                                                                                                                             | `state`        | `state`                            | state name (what the wizard writes)                                                                                            |
| `entity.created`, `entity.assigned`, `entity.unassigned`, `entity.updated`, `entity.due_date_overdue`, and the two `workflow.*` types above | `entityTypeId` | `entityTypeId`                     | uuid                                                                                                                           |
| same set                                                                                                                                    | `entityType`   | name of the event's `entityTypeId` | legacy module-seed form (`{"entityType":"ticket"}`); compared by name, never resolved name→id (names aren't unique per tenant) |

If the event lacks the field a key needs (e.g. legacy `entity.updated` without `entityTypeId`),
a rule that sets that key does **not** match. It can't be shown to be in scope.

**Exported helper:** `ruleInScope(config, event, resolveEntityTypeName): Promise<boolean>`. Pure
apart from the injected name resolver, and unit-testable. `resolveEntityTypeName` is memoised per
`executeAutomationRules` call.

**Sync path fix:** `actions/transition.ts` builds its `workflow.transitioned` event with the
transitioned instance's real `entityTypeId`, read from the instance, instead of falling back to
`instanceId`.

**Operator query (R8): rules whose matching narrows with this change.** Run it before or after
deploy to review which rules now fire less often. Each result fired on every event of its type
before, and fires only within its configured scope after.

```sql
SELECT tenant_id, id, name, trigger_type, trigger_config
FROM automation_rules
WHERE is_enabled
  AND trigger_type IN ('workflow.transitioned', 'workflow.sla_breached', 'entity.created',
                       'entity.assigned', 'entity.unassigned', 'entity.updated',
                       'entity.due_date_overdue')
  AND EXISTS (
    SELECT 1 FROM jsonb_each(trigger_config) kv
    WHERE kv.key IN ('workflowId', 'fromState', 'toState', 'state', 'entityTypeId', 'entityType')
      AND kv.value NOT IN ('null'::jsonb, '""'::jsonb)
  )
ORDER BY tenant_id, trigger_type;
```

## §R Requirements

- R1: A `workflow.transitioned` rule with `workflowId` / `fromState` / `toState` fires only for
  matching events.
- R2: An `sla_breached` rule with `workflowId` / `state` fires only for matching events.
- R3: Entity-event rules with `entityTypeId` fire only for that entity type; `{"entityType": name}`
  matches by the event entity type's name within the tenant.
- R4: `{}`, missing, `null` and `""` values match everything; unknown keys are ignored.
- R5: Out-of-scope rules write no `automation_executions` row and run no actions.
- R6: Automation-triggered transitions carry the correct `entityTypeId`.
- R7: Existing behaviour for rules with `{}` is unchanged (existing isolation suites green).
- R8: Operators can list rules whose effective matching narrows (a documented SQL query in the
  spec/runbook), to review them before or after deploy.

## §V Invariants

- V1: a non-empty scope key never widens matching; it only narrows.
- V2: the entity-type-name lookup is always tenant-filtered.

## §T Tasks

| id  | task                                                                                                                           | req       | status |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------- | ------ |
| T1  | Prove-it isolation test: wizard-shaped rules (workflowId+toState; entityTypeId; entityType name) fire for foreign events today | R1–R3, R5 | done   |
| T2  | `ruleInScope` helper + unit tests (every key, empty/null/"", unknown keys, missing event field)                                | R1–R4     | done   |
| T3  | Wire into executor before conditions / execution row; memoised tenant-filtered name resolver                                   | R5, V2    | done   |
| T4  | Fix `actions/transition.ts` sync-path `entityTypeId`, with test                                                                | R6        | done   |
| T5  | Run the existing automation isolation suites; adjust only tests that relied on ignored config, stating why                     | R7        | done   |
| T6  | Operator query for narrowed rules (R8); follow-up issue for wizard/API key mismatches and dead trigger types; docs             | R8        | done   |

## §B Bugs / Backprop Log

- **B1 — proved before the fix.** `automation-trigger-config-scoping.isolation.test.ts` failed 5
  of 6 cases before the executor change (out-of-scope events created executions). Only the
  empty-config case passed, as expected.
- **B2 — sync-path entity type.** `actions/transition.ts` copied the _triggering_ event's
  `entityTypeId`, or fell back to the instance id. `automation-transition-entity-type.isolation.test.ts`
  showed a rule scoped to the transitioned order never firing. The action now reads the
  instance's own `entityTypeId`, tenant-filtered.
- **B3 — name resolution includes system templates.** The `entityType` name lookup accepts the
  tenant's own types and `tenant_id IS NULL` templates, never another tenant's. The isolation
  test fires an event whose type is another tenant's same-named type and asserts no match.
- **B4 (PR #686 review).**
  - The name match is now case-insensitive, because entity type names carry no casing
    constraint and a case-only rename must not silently stop name-scoped rules.
  - A warning is logged when a non-empty `trigger_config` meets an event type with no scope
    keys (an emitter added without extending `SCOPE_KEYS`).
  - `actions/transition.ts` logs instead of returning silently if the instance is missing.
  - The scoping isolation test runs under `withTenantContext`.
  - The operator query still counts `false`/`0` as narrowing on purpose: they are set values,
    so they never equal a real id.
- **Follow-up:** wizard/API key mismatches (`fieldName` vs `field`, `state` vs `toState`, empty-string
  uuids) and trigger types with no emitter are filed as #684.
