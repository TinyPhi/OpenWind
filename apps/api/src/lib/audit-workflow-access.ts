import { writeAuditEntry } from "@platform/audit";

type AuditDb = Parameters<typeof writeAuditEntry>[0];

/** Order-insensitive, duplicate-insensitive comparison of two id/role lists. */
export function sameMembers(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  const left = new Set(a ?? []);
  const right = new Set(b ?? []);
  if (left.size !== right.size) return false;
  for (const v of left) if (!right.has(v)) return false;
  return true;
}

/**
 * Records a change to a workflow's admin list (`workflows.assigned_to`, #640).
 * Writes nothing when the membership is unchanged. Call on the same
 * transaction as the write.
 */
export async function auditWorkflowAdminsChange(
  tx: AuditDb,
  input: {
    tenantId: string;
    actorId: string;
    workflowId: string;
    before: readonly string[];
    after: readonly string[];
  },
): Promise<void> {
  if (sameMembers(input.before, input.after)) return;

  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorType: "user",
    resourceType: "workflow",
    resourceId: input.workflowId,
    action: "workflow.admins_updated",
    beforeSnapshot: { assignedTo: [...input.before] },
    afterSnapshot: { assignedTo: [...input.after] },
  });
}

export type TransitionRoleChange = {
  transitionId: string;
  fromState: string;
  toState: string;
  /** null when the transition is being created. */
  before: readonly string[] | null;
  /** null when the transition is being deleted, which removes its role gate. */
  after: readonly string[] | null;
};

/**
 * Records changes to which roles may fire a transition
 * (`workflow_transitions.allowed_roles`, #640): one entry per request covering
 * every transition whose role set changed, so a canvas save is one row, not one
 * per edge. A created or deleted transition always counts as a change. Writes
 * nothing when no role set changed. Call on the same transaction as the write.
 */
export async function auditTransitionRoleChanges(
  tx: AuditDb,
  input: {
    tenantId: string;
    actorId: string;
    workflowId: string;
    changes: readonly TransitionRoleChange[];
  },
): Promise<void> {
  const changed = input.changes.filter(
    (ch) =>
      ch.before === null ||
      ch.after === null ||
      !sameMembers(ch.before, ch.after),
  );
  if (changed.length === 0) return;

  await writeAuditEntry(tx, {
    tenantId: input.tenantId,
    actorId: input.actorId,
    actorType: "user",
    resourceType: "workflow",
    resourceId: input.workflowId,
    action: "workflow.transition_roles_updated",
    beforeSnapshot: Object.fromEntries(
      changed.map((ch) => [ch.transitionId, ch.before ? [...ch.before] : null]),
    ),
    afterSnapshot: Object.fromEntries(
      changed.map((ch) => [ch.transitionId, ch.after ? [...ch.after] : null]),
    ),
    metadata: {
      transitions: changed.map((ch) => ({
        transitionId: ch.transitionId,
        fromState: ch.fromState,
        toState: ch.toState,
        created: ch.before === null,
        deleted: ch.after === null,
      })),
    },
  });
}
