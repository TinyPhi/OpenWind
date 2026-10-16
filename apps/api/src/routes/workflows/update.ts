import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { workflows, withTenantContext } from "@platform/db";
import { and, eq } from "drizzle-orm";
import { updateWorkflow } from "@platform/workflow-engine";
import { factory } from "./factory.js";
import { handleWorkflowError } from "../../lib/handle-workflow-error.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";
import { listOrgUsers } from "../../lib/zitadel-management.js";
import { logger } from "@platform/logger";
import {
  auditWorkflowAdminsChange,
  auditOverridePolicyChange,
} from "../../lib/audit-workflow-access.js";

const UpdateWorkflowSchema = z.object({
  isActive: z.boolean().optional(),
  assignedTo: z.array(z.string()).optional(),
  maxChildDepth: z.number().int().min(0).max(10).nullable().optional(),
  maxChildrenPerParent: z.number().int().min(1).max(100).nullable().optional(),
  initialState: z.string().min(1).max(100).optional(),
  allowAutoGrantOnMention: z.boolean().optional(),
  allowStateOverride: z.boolean().optional(),
});

export const updateWorkflowHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", UpdateWorkflowSchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const auth = c.get("auth");
    const { tenantId, orgId } = auth;
    const input = c.req.valid("json");

    // Whether a record's state may be overridden is a control over the workflow's own rules, so
    // it is a tenant admin's decision, not any workflow admin's.
    // A person, not a key: an API key can carry the admin scope, and a leaked or over-scoped one
    // must not be able to arm overrides for someone else to use.
    if (
      input.allowStateOverride !== undefined &&
      (!auth.roles.includes("admin") || auth.userId.startsWith("apikey:"))
    ) {
      return c.json(
        {
          error: "FORBIDDEN",
          message: "Only an admin can change whether state override is allowed",
        },
        403,
      );
    }

    // Verify every workflow-admin user id is a real member of this Zitadel
    // org before writing. assignedTo here is the workflow-admins array (see
    // migration 0025_workflow_admins_array.sql) — not a single assignee, so
    // every id in the array must be checked, not just one.
    //
    // Checked against Zitadel directly (the same listOrgUsers call GET
    // /users uses to populate this exact assignment picker), not the local
    // tenant_users cache — tenant_users only gets a row for someone on their
    // *first login* (packages/auth/src/middleware.ts), so a real org member
    // who simply hasn't logged into this app yet would otherwise always
    // fail here despite being a perfectly valid assignee the UI just offered.
    if (input.assignedTo !== undefined && input.assignedTo.length > 0) {
      const orgUsers = orgId ? await listOrgUsers(orgId) : [];
      const validIds = new Set(orgUsers.map((u) => u.userId));
      const missing = input.assignedTo.filter((id) => !validIds.has(id));
      if (missing.length > 0) {
        // listOrgUsers swallows Zitadel fetch failures into [] internally
        // (same as every other caller of it, e.g. GET /users) — there's no
        // way to tell "Zitadel outage" apart from "genuinely empty org" at
        // this call site. Log it so an outage causing every id to look
        // missing is at least diagnosable, rather than silently read as
        // "these users don't exist."
        if (orgUsers.length === 0) {
          logger.warn(
            { orgId, workflowId: id },
            "workflows/update: listOrgUsers returned zero users — either a genuinely empty org or a Zitadel lookup failure; treating all assignedTo ids as not found",
          );
        }
        return c.json(
          {
            error: "NOT_FOUND",
            message: "One or more users not found in this organization",
          },
          404,
        );
      }
    }

    try {
      const workflow = await withTenantContext(tenantId, async (tx) => {
        const [before] =
          input.assignedTo !== undefined ||
          input.allowStateOverride !== undefined
            ? await tx
                .select({
                  assignedTo: workflows.assignedTo,
                  allowStateOverride: workflows.allowStateOverride,
                })
                .from(workflows)
                .where(
                  and(eq(workflows.id, id), eq(workflows.tenantId, tenantId)),
                )
                .limit(1)
            : [];
        const updated = await updateWorkflow(
          tx,
          tenantId,
          id,
          toWorkflowCaller(auth),
          input,
        );
        if (before && input.assignedTo !== undefined) {
          await auditWorkflowAdminsChange(tx, {
            tenantId,
            actorId: auth.userId,
            workflowId: id,
            before: before.assignedTo ?? [],
            after: updated.assignedTo,
          });
        }
        if (before && input.allowStateOverride !== undefined) {
          await auditOverridePolicyChange(tx, {
            tenantId,
            actorId: auth.userId,
            workflowId: id,
            before: before.allowStateOverride,
            after: updated.allowStateOverride,
          });
        }
        return updated;
      });
      return c.json({ data: workflow });
    } catch (err) {
      return handleWorkflowError(c, err);
    }
  },
);
