import type { Redis } from "ioredis";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { entityInstances } from "@platform/db";
import { logger } from "@platform/logger";
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

  // The follow-up event describes the instance that was just transitioned,
  // which config.instanceId may point at instead of the triggering entity —
  // read its entity type rather than copying the triggering event's. Rules
  // scoped by entityTypeId depend on this (#678).
  const [transitioned] = await db
    .select({ entityTypeId: entityInstances.entityTypeId })
    .from(entityInstances)
    .where(
      and(
        eq(entityInstances.id, instanceId),
        eq(entityInstances.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!transitioned) {
    // executeTransition just succeeded in this transaction, so this should be
    // unreachable — but never drop the follow-up rules silently.
    logger.warn(
      { tenantId, instanceId },
      "Automation: transition action — instance not found after transition; skipping follow-up rules",
    );
    return;
  }
  const { entityTypeId } = transitioned;

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
