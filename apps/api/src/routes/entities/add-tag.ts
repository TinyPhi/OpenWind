import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { workflowEvents, withTenantContext } from "@platform/db";
import { addEntityInstanceTag, getEntity } from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { assertRecordWorkflowAccess } from "../../lib/assert-record-workflow-access.js";

const AddTagSchema = z.object({
  // Raw text — normalization (trim+lowercase) happens inside
  // addEntityInstanceTag, not here, so the DB constraint and the app-layer
  // normalization can never disagree (single source of truth).
  tagText: z.string().min(1),
});

export const addTagHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", AddTagSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const { tagText } = c.req.valid("json");

    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    // docs/specs/ticket-severity-and-tags.md R4/R5 — same edit-access model
    // as severity: any user with ticket edit-access may add a tag.
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

    try {
      const instance = await withTenantContext(tenantId, (tx) =>
        getEntity(tx, tenantId, id),
      );

      const tag = await withTenantContext(tenantId, (tx) =>
        addEntityInstanceTag(tx, tenantId, id, tagText, userId),
      );

      // See update-severity.ts's identical comment — a ticket with no
      // workflow can't carry an activity-log entry for this change.
      if (instance.workflowId) {
        // docs/specs/ticket-severity-and-tags.md R5 — logged, never notified.
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
              type: "tag_added",
              tagText: tag.tagText,
            },
          }),
        );
      }

      return c.json({ data: tag }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
