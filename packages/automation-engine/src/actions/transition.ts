import type { DbOrTx } from "@platform/db";
import { executeTransition } from "@platform/workflow-engine";
import type { TriggerEvent } from "../event-schemas.js";
import { executeAutomationRules } from "../executor.js";
import type { TransitionConfig } from "../types.js";

export type { TransitionConfig };

export async function executeTransitionAction(
  db: DbOrTx,
  tenantId: string,
  event: TriggerEvent,
  config: TransitionConfig,
  depth: number,
): Promise<void> {
  const instanceId =
    config.instanceId ?? ("instanceId" in event ? event.instanceId : undefined);
  if (!instanceId) return;

  const workflowEvent = await executeTransition(db, tenantId, {
    instanceId,
    transitionId: config.transitionId,
    triggeredBy: "automation",
    ...(config.comment !== undefined && { comment: config.comment }),
  });

  // Propagate entityTypeId from the triggering event when available (all four
  // TriggerEvent variants carry entityTypeId). When config.instanceId targets
  // a different entity than the one that fired the rule, the entityTypeId will
  // be wrong; a full fix requires a DB lookup which is deferred.
  const entityTypeId =
    "entityTypeId" in event ? (event.entityTypeId as string) : instanceId;

  // Recursively execute rules triggered by this transition (depth + 1 for guard)
  const followUpEvent = {
    version: 1 as const,
    eventType: "workflow.transitioned" as const,
    tenantId,
    instanceId,
    entityTypeId,
    workflowId: workflowEvent.workflowId,
    fromState: workflowEvent.fromState,
    toState: workflowEvent.toState,
    triggeredBy: "automation" as const,
    actorId: null,
    occurredAt: workflowEvent.createdAt.toISOString(),
  };

  await executeAutomationRules(db, tenantId, followUpEvent, depth + 1);
}
