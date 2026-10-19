import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  createChildRelation,
  TicketSeveritySchema,
  ValidationError,
} from "@platform/entity-engine";
import { logger } from "@platform/logger";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { assertRecordWorkflowAccess } from "../../lib/assert-record-workflow-access.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";
import { ensureTenantMembers } from "../../lib/ensure-user-refs.js";
import { postRemarkComment } from "../../lib/post-remark-comment.js";

// The same 15 s allowance createEntity gives a due date set "now".
const DUE_DATE_GRACE_MS = 15_000;

// docs/specs/mandatory-ticket-fields.md R4 (owner decision 1): a sub-task carries the same
// four mandatory values as a full ticket -- title, due date, remark and severity -- and at
// most one of an assignee or a team (unassigned is allowed, 2026-10-19).
const CreateChildSchema = z
  .object({
    entityTypeId: z.string().uuid(),
    fields: z.record(z.unknown()).default({}),
    assignedTo: z.string().min(1).optional(),
    teamId: z.string().uuid().optional(),
    dueDate: z
      .string()
      .datetime()
      .refine((v) => new Date(v).getTime() >= Date.now() - DUE_DATE_GRACE_MS, {
        message: "Due date must be in the future",
      }),
    remark: z.string().trim().min(1).max(4000),
    severity: TicketSeveritySchema.default("medium"),
  })
  .superRefine((input, ctx) => {
    const title = input.fields["title"];
    if (typeof title !== "string" || title.trim() === "") {
      ctx.addIssue({
        code: "custom",
        path: ["fields", "title"],
        message: "Title is required",
      });
    }
    // Unassigned is allowed; a person and a team together are not.
    if (input.assignedTo !== undefined && input.teamId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["teamId"],
        message: "Set at most one of assignedTo or teamId",
      });
    }
  });

export const createChildHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateChildSchema),
  async (c) => {
    const parentId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId, userId, orgId } = auth;
    // "agent" is a tenant-wide role that already creates sub-tickets under
    // any parent (matches the pre-existing requireRole("admin","agent")
    // contract); only "user" callers are subject to the extra full-access
    // check below — creator, assignee, or workflow admin of the parent.
    const isAgentOrAdmin =
      auth.roles.includes("admin") || auth.roles.includes("agent");
    const caller = toWorkflowCaller(auth);

    try {
      const result = await withTenantContext(tenantId, async (tx) => {
        if (!isAgentOrAdmin) {
          await assertRecordWorkflowAccess(tx, tenantId, parentId, caller);
        }
        // The assignee must belong to this tenant: a colleague who has never signed in is
        // registered from the tenant's Zitadel org; anyone else is refused.
        if (input.assignedTo !== undefined) {
          const members = await ensureTenantMembers(
            tx,
            tenantId,
            [input.assignedTo],
            orgId,
          );
          if (!members.has(input.assignedTo)) {
            throw new ValidationError([
              {
                field: "assignedTo",
                code: "invalid",
                message: "Must be a member of this organisation",
              },
            ]);
          }
        }
        return createChildRelation(tx, tenantId, {
          parentId,
          entityTypeId: input.entityTypeId,
          childFields: input.fields,
          assignedTo: input.assignedTo,
          teamId: input.teamId,
          createdBy: userId,
          dueDate: input.dueDate,
          remark: input.remark,
          severity: input.severity,
        });
      });

      // Best-effort, after the create commits -- the same remark-as-first-comment behaviour
      // as a full ticket (routes/entities/create.ts).
      const child = result.instance;
      if (child.workflowId) {
        try {
          await withTenantContext(tenantId, (tx) =>
            postRemarkComment(tx, {
              tenantId,
              instanceId: child.id,
              workflowId: child.workflowId as string,
              currentState: child.currentState,
              actorId: userId,
              text: input.remark,
            }),
          );
        } catch (remarkErr) {
          logger.warn(
            { remarkErr, tenantId, instanceId: child.id },
            "sub-task create: failed to post remark as first comment",
          );
        }
      }

      return c.json({ data: result }, 201);
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
