import type { DbOrTx } from "@platform/db";
import { workflowEvents, outboxEvents } from "@platform/db";

/**
 * Posts a rule-fired ticket's `remark` as its first comment, attributed to
 * the rule's creator (there is no live human actor for a scheduled fire --
 * docs/specs/schedule-rules-mandate-fields.md R5).
 *
 * Deliberately NOT reused from apps/api/src/lib/post-remark-comment.ts: this
 * runs inside the worker (packages/scheduler), which is not allowed to
 * import apps/api per the repo's dependency rule (apps/* -> packages/*,
 * never the reverse) -- same workflow_events + outbox_events shape as that
 * helper and packages/automation-engine's post-oncall-comment.ts, kept in
 * sync with both, not diverged.
 *
 * Deliberately best-effort: call this OUTSIDE the create transaction, after
 * it has committed, and swallow failures at the call site (logged, not
 * thrown) -- by the time this runs the ticket already exists, so a failure
 * here must never fail the schedule fire itself.
 */
export async function postScheduleRemarkComment(
  tx: DbOrTx,
  params: {
    tenantId: string;
    instanceId: string;
    workflowId: string;
    currentState: string;
    actorId: string;
    text: string;
  },
): Promise<void> {
  const { tenantId, instanceId, workflowId, currentState, actorId, text } =
    params;

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
        actorName: null,
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
