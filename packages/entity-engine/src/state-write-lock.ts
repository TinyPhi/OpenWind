import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { workflows, workflowStates, workflowTransitions } from "@platform/db";

// A workflow whose transitions carry an actor rule (segregation of duties), or that has switched
// the admin override on, must not have its records' step written directly: the column write skips
// the transition guards, so the rule would bind nobody who simply asked for the state. The record
// moves by a transition, or by the recorded override (docs/specs/state-override.md). Workflows
// with neither keep the older direct-write path.
//
// The `conditions` jsonb is searched as text for the two operator names. The write-time schema
// (TransitionConditionsSchema) only admits known operators, so `"actor_` can only be an operator.
const ACTOR_RULE_PATTERN = '%"actor\\_%';

export async function lockedWorkflowIds(
  db: DbOrTx,
  tenantId: string,
  workflowIds: readonly string[],
): Promise<Set<string>> {
  if (workflowIds.length === 0) return new Set();
  const rows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, tenantId),
        inArray(workflows.id, [...workflowIds]),
        or(
          eq(workflows.allowStateOverride, true),
          sql`EXISTS (
            SELECT 1 FROM ${workflowTransitions} t
            WHERE t.workflow_id = ${workflows.id}
              AND t.tenant_id = ${tenantId}
              AND t.conditions::text LIKE ${ACTOR_RULE_PATTERN}
          )`,
        ),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

export async function isStateWriteLocked(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
): Promise<boolean> {
  return (await lockedWorkflowIds(db, tenantId, [workflowId])).has(workflowId);
}

// A record attached under a parent counts as a child ticket and takes the fixed
// open/in-progress/closed list instead of its workflow's steps. On a locked workflow that list
// must not become a way to reach one of the workflow's own steps (a workflow can have a step
// named "closed"), so a child write is refused when the target is also a step of the record's
// workflow. A target that is not one of its steps cannot skip a rule, and stays allowed.
export async function workflowHasStateNamed(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  name: string,
): Promise<boolean> {
  const rows = await db
    .select({ name: workflowStates.name })
    .from(workflowStates)
    .where(
      and(
        eq(workflowStates.workflowId, workflowId),
        eq(workflowStates.tenantId, tenantId),
        eq(workflowStates.name, name),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function childStateWriteReachesLockedStep(
  db: DbOrTx,
  tenantId: string,
  workflowId: string,
  name: string,
): Promise<boolean> {
  if (!(await isStateWriteLocked(db, tenantId, workflowId))) return false;
  return workflowHasStateNamed(db, tenantId, workflowId, name);
}
