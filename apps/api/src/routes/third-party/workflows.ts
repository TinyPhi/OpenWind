import { z } from "zod";
import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db } from "@platform/db";
import { listWorkflowsSummary } from "@platform/workflow-engine";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";

const ListThirdPartyWorkflowsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * GET /api/v1/workflows — ADR-012 Phase B, spec R5.
 *
 * Listing is tenant-wide (see packages/workflow-engine/src/workflow-crud.ts's
 * own comment: "any tenant user can see every workflow that exists" —
 * ownership only gates mutation, not listing), so there is no per-person ACL
 * filter to apply here beyond scope + tenant. Response is deliberately
 * narrowed to id/name/entityTypeId — no state list (ticket creation always
 * forces the initial state regardless, R6), no other UI-only fields.
 */
export const listThirdPartyWorkflowsHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("read"),
  zValidator("query", ListThirdPartyWorkflowsQuerySchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { limit, offset } = c.req.valid("query");

    // WorkflowCaller is accepted-but-unused by listWorkflowsSummary's
    // tenant-wide listing (see that function's own comment) — the acting
    // person's real userId is passed for API-shape consistency with other
    // workflow-crud callers, never actually read for a list call.
    const caller = {
      userId: c.get("actingPerson").userId,
      isGlobalAdmin: false,
    };

    const rows = await withTenantContext(tenantId, (tx) =>
      listWorkflowsSummary(
        tx,
        tenantId,
        caller,
        undefined,
        true,
        limit,
        offset,
      ),
    );

    return c.json({
      data: rows.map((w) => ({
        id: w.id,
        name: w.name,
        entityTypeId: w.entityTypeId,
      })),
    });
  },
);
