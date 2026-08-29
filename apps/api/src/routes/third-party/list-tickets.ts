import { z } from "zod";
import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db, entityFields } from "@platform/db";
import { eq, and, or, isNull } from "drizzle-orm";
import {
  listEntities,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  decodeCursor,
} from "@platform/entity-engine";
import type { EntityInstance } from "@platform/entity-engine";
import {
  getWorkflow,
  WorkflowError,
  isWorkflowAdmin,
  buildSensitivityMap,
  redactMetadata,
} from "@platform/workflow-engine";
import type { FieldSensitivity } from "@platform/workflow-engine";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { notFound } from "./not-found.js";
import { stripInternalFields } from "../../lib/strip-internal-fields.js";

function isWorkflowNotFound(err: unknown): boolean {
  return err instanceof WorkflowError && err.code === "WORKFLOW_NOT_FOUND";
}

const ListThirdPartyTicketsQuerySchema = z.object({
  state: z.string().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

// A recognized __accessUsers grant level -- mirrors hasEntityReadAccess's own
// check (packages/workflow-engine/src/entity-access.ts). listEntities'
// scopeToUserId matches an __accessUsers KEY regardless of its level value;
// this set is used to post-filter that looser match back down to exactly
// what hasEntityAccess would also allow, so a ticket never appears in this
// list only to 404 on GET /tickets/:id for the same acting person (spec
// docs/specs/third-party-api-list-my-tickets.md R1's list/get-parity
// criterion, and its own §V invariant).
const RECOGNIZED_ACCESS_LEVELS = new Set([
  "read_only",
  "read_comment",
  "read_write",
]);

function passesListGetParity(
  instance: EntityInstance,
  actingPersonId: string,
): boolean {
  if (instance.createdBy === actingPersonId) return true;
  if (instance.assignedTo === actingPersonId) return true;
  const accessUsers = (instance.fields as Record<string, unknown> | null)?.[
    "__accessUsers"
  ] as Record<string, { level?: string }> | undefined;
  const grant = accessUsers?.[actingPersonId];
  return !!grant && RECOGNIZED_ACCESS_LEVELS.has(grant.level ?? "");
}

/**
 * GET /api/v1/workflows/:workflowId/tickets -- ADR-012 (unaddressed by the
 * ADR itself; this spec is the first to establish the pattern), spec
 * docs/specs/third-party-api-list-my-tickets.md.
 *
 * Mirrors the internal records page (apps/api/src/routes/entities/list.ts)
 * exactly: scopeToUserId = actingPersonId (creator OR assignee OR
 * __accessUsers key-exists) UNLESS the acting person is the workflow's
 * admin, in which case the scope filter is dropped entirely (full
 * visibility) -- same all-or-nothing bypass shape list.ts already uses.
 *
 * List/get parity: listEntities' scopeToUserId match on __accessUsers is
 * looser than hasEntityAccess's (used by GET /tickets/:id) -- it doesn't
 * check the grant's level. passesListGetParity() re-applies that stricter
 * check as a post-filter over the already-fetched page, so a ticket never
 * appears here only to 404 when opened via GET /tickets/:id. The pagination
 * cursor is always derived from the PRE-filter batch (the raw page fetched
 * from listEntities), never recomputed from the post-filter result, so this
 * filter changes page CONTENTS, never page BOUNDARIES.
 */
export const listThirdPartyTicketsHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("read"),
  zValidator("query", ListThirdPartyTicketsQuerySchema),
  async (c) => {
    const workflowId = c.req.param("workflowId") ?? "";
    const { tenantId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");
    const { state, limit, cursor } = c.req.valid("query");

    // Same shape/status as zValidator's own query-param validation failures
    // (apps/api/src/lib/validator.ts) -- a malformed cursor is a malformed
    // request, the same class of error as an out-of-range `limit`, which
    // zValidator already rejects with 400, not 422 (422 is reserved for
    // field-schema/business-rule failures on a request BODY elsewhere in
    // this API, e.g. POST /tickets's fields payload).
    if (cursor !== undefined && decodeCursor(cursor) === null) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "Request validation failed",
          fields: [
            {
              field: "cursor",
              code: "invalid_cursor",
              message: "Malformed cursor",
            },
          ],
        },
        400,
      );
    }

    try {
      const { workflow, page } = await withTenantContext(
        tenantId,
        async (tx) => {
          const workflow = await getWorkflow(tx, tenantId, workflowId, {
            userId: actingPersonId,
            isGlobalAdmin: false,
          });
          const admin = isWorkflowAdmin(actingPersonId, workflow);
          const page = await listEntities(tx, tenantId, {
            entityTypeId: workflow.entityTypeId,
            state,
            scopeToUserId: admin ? undefined : actingPersonId,
            limit,
            cursor,
          });
          return { workflow, page };
        },
      );

      // Post-filter for list/get parity (only relevant for non-admin callers
      // -- an admin's unscoped page has no ACL-grant-only rows to reconcile
      // against since every row is already visible regardless of relation).
      const admin = isWorkflowAdmin(actingPersonId, workflow);
      const filtered = admin
        ? page.data
        : page.data.filter((instance) =>
            passesListGetParity(instance, actingPersonId),
          );

      // Redaction sensitivity map computed once per page (entity-type-
      // invariant across every row in this response), not once per row.
      const sensitivityRows = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            name: entityFields.name,
            sensitivity: entityFields.sensitivity,
          })
          .from(entityFields)
          .where(
            and(
              eq(entityFields.entityTypeId, workflow.entityTypeId),
              or(
                isNull(entityFields.tenantId),
                eq(entityFields.tenantId, tenantId),
              ),
            ),
          ),
      );
      const sensitivityMap = buildSensitivityMap(
        sensitivityRows.map((r) => ({
          name: r.name,
          sensitivity: r.sensitivity as FieldSensitivity,
        })),
      );

      const data = filtered.map((instance) => ({
        id: instance.id,
        entityTypeId: instance.entityTypeId,
        workflowId: workflow.id,
        currentState: instance.currentState,
        fields: stripInternalFields(
          redactMetadata(instance.fields, sensitivityMap),
        ),
        createdBy: instance.createdBy,
        assignedTo: instance.assignedTo,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
      }));

      return c.json({ data, nextCursor: page.nextCursor });
    } catch (err) {
      if (isWorkflowNotFound(err)) {
        return notFound(c);
      }
      throw err;
    }
  },
);
