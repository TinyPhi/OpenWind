import { requireAuth, requireRole } from "@platform/auth";
import {
  entityInstances,
  workflowEvents,
  withTenantContext,
} from "@platform/db";
import { getWorkflow, isWorkflowAdmin } from "@platform/workflow-engine";
import { removeEntityInstanceTag, getEntity } from "@platform/entity-engine";
import { eq, and } from "drizzle-orm";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { assertRecordWorkflowAccess } from "../../lib/assert-record-workflow-access.js";

export const removeTagHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const tagId = c.req.param("tagId") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    // docs/specs/ticket-severity-and-tags.md R4/R5 — same ticket-access gate
    // as add-tag.ts/update-severity.ts: a caller with no relationship to this
    // ticket at all (not creator/assignee/workflow-admin, not privileged)
    // must get 404 regardless of whether the tagId exists or who owns it —
    // otherwise TAG_NOT_FOUND vs TAG_FORBIDDEN leaks the tag's existence to
    // someone who can't even read the ticket (security.md's 404-not-403
    // rule). This is distinct from allowAdminOverride below: having ticket
    // access (e.g. being the assignee) is NOT the same as being allowed to
    // override another user's creator-lock.
    if (!isPrivileged) {
      try {
        await withTenantContext(tenantId, (tx) =>
          assertRecordWorkflowAccess(tx, tenantId, id, {
            userId,
            isGlobalAdmin: false,
          }),
        );
      } catch (err) {
        return handleEntityError(c, err);
      }
    }

    // docs/specs/ticket-severity-and-tags.md R5 — global admin (here: the
    // "admin"/"agent" full-access tier, matching this codebase's existing
    // convention elsewhere — e.g. add-comment.ts's isPrivileged) or a
    // workflow admin of THIS record's workflow may remove any tag,
    // overriding the creator-lock enforced inside removeEntityInstanceTag.
    // Everyone else can only remove their own tag — that check happens
    // inside removeEntityInstanceTag itself, not here.
    let allowAdminOverride = isPrivileged;
    if (!allowAdminOverride) {
      try {
        const [row] = await withTenantContext(tenantId, (tx) =>
          tx
            .select({ workflowId: entityInstances.workflowId })
            .from(entityInstances)
            .where(
              and(
                eq(entityInstances.id, id),
                eq(entityInstances.tenantId, tenantId),
              ),
            )
            .limit(1),
        );
        if (row?.workflowId) {
          const workflow = await withTenantContext(tenantId, (tx) =>
            getWorkflow(tx, tenantId, row.workflowId as string, {
              userId,
              isGlobalAdmin: false,
            }),
          );
          allowAdminOverride = isWorkflowAdmin(userId, workflow);
        }
      } catch (err) {
        return handleEntityError(c, err);
      }
    }

    try {
      const instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, id),
      );

      const removed = await withTenantContext(tenantId, (tx) =>
        removeEntityInstanceTag(
          tx,
          tenantId,
          id,
          tagId,
          userId,
          allowAdminOverride,
        ),
      );

      // See update-severity.ts's identical comment — a ticket with no
      // workflow can't carry an activity-log entry for this change.
      if (instance.workflowId) {
        // docs/specs/ticket-severity-and-tags.md R5 — logged (recording the
        // original creator id whenever the remover differs from them, i.e.
        // an admin-override removal), never notified.
        await withTenantContext(tenantId, (tx) =>
          tx.insert(workflowEvents).values({
            tenantId,
            instanceId: id,
            workflowId: instance.workflowId as string,
            fromState: instance.currentState,
            toState: instance.currentState,
            triggeredBy: "user",
            actorId: userId,
            comment: null,
            metadata: {
              type: "tag_removed",
              tagText: removed.tagText,
              ...(removed.createdBy !== userId && {
                originalCreatedBy: removed.createdBy,
              }),
            },
          }),
        );
      }

      return c.body(null, 204);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
