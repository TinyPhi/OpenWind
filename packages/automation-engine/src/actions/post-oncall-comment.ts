import type { DbOrTx } from "@platform/db";
import { workflowEvents, outboxEvents } from "@platform/db";

/**
 * Posts a "System"-attributed summary comment for one resolve_oncall
 * terminal outcome (docs/specs/team-assign-oncall-fallback.md R5) — either a
 * successful auto-assignment (naming the tier) or a fully fail-open result
 * (no coverage found at any of the 4 tiers).
 *
 * Deliberately NOT reused from apps/api/src/lib/post-system-comment.ts /
 * post-remark-comment.ts: this action runs inside packages/automation-engine
 * (the worker path), which is not allowed to import apps/api per the
 * repo's dependency rule (apps/* -> packages/*, never the reverse). Same
 * workflow_events + outbox_events shape as those two helpers, deliberately
 * kept in sync with them — do not diverge on schema.
 *
 * No-op (and does not throw) when the ticket has no governing workflow —
 * workflow_events.workflow_id is NOT NULL, so a workflowless ticket simply
 * gets no comment, mirroring apps/api/src/routes/entities/create.ts's own
 * `if (instance.workflowId)` guard around postRemarkComment.
 */
export async function postOncallComment(
  tx: DbOrTx,
  params: {
    tenantId: string;
    instanceId: string;
    workflowId: string | null;
    currentState: string;
    text: string;
  },
): Promise<void> {
  const { tenantId, instanceId, workflowId, currentState, text } = params;
  if (!workflowId) return;

  const [event] = await tx
    .insert(workflowEvents)
    .values({
      tenantId,
      instanceId,
      workflowId,
      fromState: currentState,
      toState: currentState,
      triggeredBy: "system",
      actorId: "system",
      comment: null,
      metadata: {
        type: "comment",
        text,
        actorName: "System",
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
      actorId: "system",
      commentId: event.id,
    },
  });
}
