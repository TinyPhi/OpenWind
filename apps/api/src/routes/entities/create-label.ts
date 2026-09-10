/**
 * POST /entities/:id/labels — assign an existing label to a ticket
 * (docs/specs/oncall-routing.md T38, R1c). Mirrors create-relation.ts's
 * access model: agent/admin can label freely, a plain "user" caller needs
 * full access to the record (creator/assignee/workflow-admin).
 *
 * ticket_labels.label_id has NO DB foreign key (migration 0097's comment) --
 * cross-tenant ownership of labelId is validated here at the app layer via
 * the shared FK helper (R1d/T44), closing PR #585 review B1 / issue #592's
 * ticket_labels half.
 */

import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext, labels, ticketLabels } from "@platform/db";
import { getEntity } from "@platform/entity-engine";
import {
  lookupValidIdsInTable,
  validateCrossTenantRefs,
} from "@platform/teams";
import { writeAuditEntry } from "@platform/audit";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { assertRecordWorkflowAccess } from "../../lib/assert-record-workflow-access.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";

const AssignLabelSchema = z.object({
  labelId: z.string().uuid(),
});

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "cause" in err &&
    err.cause &&
    typeof err.cause === "object" &&
    "code" in err.cause &&
    err.cause.code === "23505",
  );
}

export const createLabelHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", AssignLabelSchema),
  async (c) => {
    const ticketInstanceId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId } = auth;
    const isAgentOrAdmin =
      auth.roles.includes("admin") || auth.roles.includes("agent");
    const caller = toWorkflowCaller(auth);

    try {
      const result = await withTenantContext(tenantId, async (tx) => {
        await getEntity(tx, tenantId, ticketInstanceId);
        if (!isAgentOrAdmin) {
          await assertRecordWorkflowAccess(
            tx,
            tenantId,
            ticketInstanceId,
            caller,
          );
        }

        const lookup = lookupValidIdsInTable(
          tx,
          labels,
          labels.id,
          labels.tenantId,
          labels.deletedAt,
          tenantId,
        );
        const refErrors = await validateCrossTenantRefs(
          [{ fieldName: "labelId", refId: input.labelId }],
          lookup,
        );
        if (refErrors.length > 0) {
          return { status: "invalid" as const, refErrors };
        }

        const [row] = await tx
          .insert(ticketLabels)
          .values({
            ticketInstanceId,
            labelId: input.labelId,
            tenantId,
            assignedBy: auth.userId,
          })
          .returning();
        if (row) {
          await writeAuditEntry(tx, {
            tenantId,
            actorId: auth.userId,
            actorType: "user",
            resourceType: "ticket_label",
            resourceId: `${row.ticketInstanceId}:${row.labelId}`,
            action: "label.assigned",
            afterSnapshot: {
              ticketInstanceId: row.ticketInstanceId,
              labelId: row.labelId,
            },
          });
        }
        return { status: "created" as const, row };
      });

      if (result.status === "invalid") {
        return c.json(
          {
            error: "VALIDATION_ERROR",
            message: "Validation failed",
            fields: result.refErrors,
          },
          422,
        );
      }
      return c.json({ data: result.row }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json(
          {
            error: "CONFLICT",
            message: "This label is already assigned to this ticket",
          },
          409,
        );
      }
      return handleEntityError(c, err);
    }
  },
);
