import type { DbOrTx } from "@platform/db";
import { workflowEvents, outboxEvents } from "@platform/db";

/**
 * Posts a system-generated comment ("System") notifying one specific user
 * that something they submitted via the third-party API (an assignedTo
 * value, a comment mention) could not be resolved to a real org member.
 *
 * Ported from the sibling AuthNexus-paired fork's identical fix (2026-09-08).
 * Design: this exists specifically so the API response itself never has to
 * reveal whether an identifier resolved -- the request always succeeds (201,
 * comment/ticket created as submitted), and the *only* place the caller
 * learns "that didn't resolve" is a notification delivered to the one person
 * who submitted it, through the normal in-app/email channel a real reply or
 * mention would use. This turns a free, instant, scriptable oracle (a 422 in
 * the HTTP response, checkable thousands of times a minute) into one that
 * costs a real comment on a real ticket and a real notification per guess --
 * self-limiting and visible in the ticket's own history, not silently
 * probeable.
 *
 * `replyToEventId` should be the id of an existing comment authored by
 * `notifyUserId` -- the reply then rides the existing `comment.replied`
 * notification path (see add-comment.ts), which notifies exactly that
 * comment's own author. When no such comment exists (this tree's third-party
 * ticket/child create schemas have no remark field to seed one from), pass
 * `replyToEventId: undefined` and this posts a top-level comment instead,
 * notifying `notifyUserId` via the existing `comment.mentioned` path -- same
 * notification outcome, no reply target required.
 *
 * `actorId`/`triggeredBy` are the fixed sentinel `"system"` (never a real
 * user id), with `metadata.actorName: "System"` set so the comment
 * timeline renders a fixed label without attempting an org-member lookup.
 * Deliberately NOT "System Agent" or "system" -- ported from the sibling
 * AuthNexus fork's own same-day fix: (1) originally this set
 * originMechanism: "api" / originOidcClientId (copied from the request
 * context that triggered it), which made OriginTag render this internal
 * message as "External · <caller's app>", wrongly attributing an
 * internally-generated notice to the third-party application whose
 * request happened to surface the failure -- fixed by not setting any
 * origin fields at all (a null origin renders no tag, same as any other
 * normal in-app comment). (2) list-workflow-events.ts's snapshot-name
 * dedup guard discards metadata.actorName whenever it exactly equals
 * actorId -- if this were the lowercase "system" sentinel, it would
 * collide with actorId: "system" and render as a truncated "system…";
 * "System" (capitalized) sidesteps that entirely.
 */
export async function postSystemComment(
  tx: DbOrTx,
  params: {
    tenantId: string;
    instanceId: string;
    workflowId: string;
    currentState: string;
    text: string;
    replyToEventId?: string | undefined;
    notifyUserId: string;
  },
): Promise<void> {
  const {
    tenantId,
    instanceId,
    workflowId,
    currentState,
    text,
    replyToEventId,
    notifyUserId,
  } = params;

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
        ...(replyToEventId ? { replyTo: replyToEventId } : {}),
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

  await tx.insert(outboxEvents).values(
    replyToEventId
      ? {
          tenantId,
          eventType: "comment.replied",
          version: 1,
          payload: {
            eventType: "comment.replied",
            version: 1,
            tenantId,
            instanceId,
            actorId: "system",
            targetUserId: notifyUserId,
          },
        }
      : {
          tenantId,
          eventType: "comment.mentioned",
          version: 1,
          payload: {
            eventType: "comment.mentioned",
            version: 1,
            tenantId,
            instanceId,
            actorId: "system",
            mentionedUserIds: [notifyUserId],
          },
        },
  );
}
