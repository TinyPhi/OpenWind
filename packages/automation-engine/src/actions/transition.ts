import type { Redis } from "ioredis";
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
  redis?: Redis,
  outboxEventId?: string,
): Promise<void> {
  const instanceId =
    config.instanceId ?? ("instanceId" in event ? event.instanceId : undefined);
  if (!instanceId) return;

  const workflowEvent = await executeTransition(db, tenantId, {
    instanceId,
    transitionId: config.transitionId,
    triggeredBy: "automation",
    depth,
    ...(config.comment !== undefined && { comment: config.comment }),
  });

  // Propagate entityTypeId from the triggering event when available (all four
  // TriggerEvent variants carry entityTypeId). When config.instanceId targets
  // a different entity than the one that fired the rule, the entityTypeId will
  // be wrong; a full fix requires a DB lookup which is deferred.
  const entityTypeId =
    "entityTypeId" in event ? (event.entityTypeId as string) : instanceId;

  // This recursive call — together with engine.ts's outbox-write skip for
  // triggeredBy === "automation" — IS the actual double-trigger guard for
  // issue #120: automation-triggered transitions recurse in-process with
  // this bounded depth counter instead of also going through the async
  // outbox/worker path, which would otherwise fire every matching rule a
  // second time. `depth + 1` here is read by executeAutomationRules's own
  // MAX_DEPTH check, not by anything in workflow-engine.
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

  await executeAutomationRules(
    db,
    tenantId,
    followUpEvent,
    depth + 1,
    redis,
    outboxEventId,
    // The transition just performed above generated its own transitionEventId
    // (engine.ts) and wrote it to the outbox row for that same transition —
    // passing it here means this in-process rule execution claims the exact
    // key the async worker path will later see for that outbox row, so the
    // consumer-side dedup (executor.ts) sees one identity, not two. See #143.
    workflowEvent.transitionEventId,
  );
}
