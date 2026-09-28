import type { DbOrTx } from "@platform/db";
import { workflowEvents, outboxEvents } from "@platform/db";

/**
 * Posts a newly-created ticket's `remark` as its first comment, attributed
 * to the real creator (never "System" -- this is the creator's own text,
 * not a system-generated notice; contrast post-system-comment.ts).
 *
 * Mandatory-ticket-fields sync, 2026-09-21 -- mirrors nexus-OW's confirmed
 * behavior: stored directly on entity_instances.remark (the caller already
 * did that as part of the create), AND additionally surfaced as an ordinary
 * comment through the same workflow_events/outbox pattern add-comment.ts
 * uses -- not a special-cased "remark comment" type, indistinguishable from
 * any other comment once posted.
 *
 * Deliberately best-effort: call this OUTSIDE the create transaction, after
 * it has committed, and swallow failures at the call site (logged, not
 * thrown) -- by the time this runs the ticket already exists, so a failure
 * here must never appear to the caller as a failed ticket creation.
 */
export async function postRemarkComment(
  tx: DbOrTx,
  params: {
    tenantId: string;
    instanceId: string;
    workflowId: string;
    currentState: string;
    actorId: string;
    actorName?: string | undefined;
    text: string;
  },
): Promise<void> {
  const {
    tenantId,
    instanceId,
    workflowId,
    currentState,
    actorId,
    actorName,
    text,
  } = params;

  const [event] = await tx
    .insert(workflowEvents)
    .values({
      tenantId,
      instanceId,
      workflowId,
      fromState: currentState,
      toState: currentState,
      triggeredBy: "user",
      actorId,
      comment: null,
      metadata: {
        type: "comment",
        text,
        mentions: [],
        replyTo: null,
        actorName: actorName ?? null,
      },
    })
    .returning();

  if (!event) return;

  await tx.insert(outboxEvents).values({
    tenantId,
    eventType: "comment.created",
    version: 1,
    payload: {
      eventType: "comment.created",
      version: 1,
      tenantId,
      instanceId,
      actorId,
      commentId: event.id,
    },
  });
}
