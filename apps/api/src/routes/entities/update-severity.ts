import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "@platform/auth";
import {
  tenantUsers,
  workflowEvents,
  outboxEvents,
  withTenantContext,
} from "@platform/db";
import {
  setEntityInstanceSeverity,
  TicketSeveritySchema,
} from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { assertRecordWorkflowAccess } from "../../lib/assert-record-workflow-access.js";

const UpdateSeveritySchema = z.object({
  // Required, not optional — this route exists specifically to enforce
  // docs/specs/ticket-severity-and-tags.md R2/R3: a missing value is a
  // validation error (422 via zValidator), not silently ignored.
  severity: TicketSeveritySchema,
});

export const updateSeverityHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", UpdateSeveritySchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");
    const { severity } = c.req.valid("json");

    const isPrivileged = roles.includes("admin") || roles.includes("agent");

    // docs/specs/ticket-severity-and-tags.md R3 — same "full access" model as
    // assertRecordWorkflowAccess's other call sites (creator, assignee, or a
    // workflow admin of the record's workflow); admin/agent bypass entirely.
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
      const [dbUser] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            displayName: tenantUsers.displayName,
            email: tenantUsers.email,
          })
          .from(tenantUsers)
          .where(
            and(
              eq(tenantUsers.userId, userId),
              eq(tenantUsers.tenantId, tenantId),
            ),
          )
          .limit(1),
      );
      const actorName =
        dbUser?.displayName && dbUser.displayName !== userId
          ? dbUser.displayName
          : dbUser?.email && dbUser.email !== userId
            ? dbUser.email
            : null;

      const { instance, previousSeverity } = await withTenantContext(
        tenantId,
        (tx) => setEntityInstanceSeverity(tx, tenantId, id, severity),
      );

      // workflow_events.workflow_id is NOT NULL — a ticket with no workflow
      // (rare, but possible for child tickets created before the workflow-
      // inheritance fix; see add-comment.ts's own walk-up-to-parent comment)
      // simply can't carry an activity-log entry for this change. Severity
      // itself was still updated above; only the log entry/notification are
      // skipped.
      if (previousSeverity !== severity && instance.workflowId) {
        // docs/specs/ticket-severity-and-tags.md R3 — activity-log entry,
        // same workflow_events mechanism add-comment.ts uses for the
        // ticket-detail timeline (metadata.type distinguishes it from a
        // transition/comment; getWorkflowEventLog's "history" bucket already
        // includes anything whose metadata.type isn't "comment", so this
        // needs no changes there).
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
              type: "severity_changed",
              previousSeverity,
              severity,
              actorName,
            },
          }),
        );

        // docs/specs/ticket-severity-and-tags.md R3 — fires an in-app+email
        // notification (via the existing outbound service) to everyone with
        // ticket access; notification-recipients.ts resolves the full access
        // list at processing time, not from a snapshot taken here.
        await withTenantContext(tenantId, (tx) =>
          tx.insert(outboxEvents).values({
            tenantId,
            eventType: "ticket.severity_changed",
            version: 1,
            payload: {
              eventType: "ticket.severity_changed",
              version: 1,
              tenantId,
              instanceId: id,
              actorId: userId,
              previousSeverity,
              severity,
            },
          }),
        );
      }

      return c.json({ data: instance });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
