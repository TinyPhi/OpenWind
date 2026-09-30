import { zValidator } from "../../lib/validator.js";
import { z } from "zod";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  createRelation,
  getEntity,
  RELATION_CHILD_OF,
  RELATION_PARENT_OF,
  RELATION_REFERENCED_BY,
  RELATION_REFERENCES,
} from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { assertRecordWorkflowAccess } from "../../lib/assert-record-workflow-access.js";
import { toWorkflowCaller } from "../../lib/workflow-caller.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

// Relation types the engine gives meaning to. The constants are lowercase, so
// the lowercased input below matches them whatever case the caller sent. They are created only through
// their own routes, which enforce one-parent, depth and cycle rules (children)
// and access on both ends (references). Written through the generic route they
// would skip those rules while still being read as real hierarchy/links.
const ENGINE_RELATION_TYPES = new Set([
  RELATION_PARENT_OF,
  RELATION_CHILD_OF,
  RELATION_REFERENCES,
  RELATION_REFERENCED_BY,
]);

// Thrown inside the transaction when a user-role caller cannot see the target;
// answered with the same body as a missing target.
class TargetUnavailableError extends Error {
  constructor() {
    super("relation target unavailable");
    this.name = "TargetUnavailableError";
  }
}

const CreateRelationSchema = z.object({
  toInstanceId: z.string().uuid(),
  relationType: z.string().min(1).max(100),
});

export const createRelationHandler = factory.createHandlers(
  requireAuth(),
  requireRole("admin", "agent", "user"),
  zValidator("json", CreateRelationSchema),
  async (c) => {
    const fromInstanceId = c.req.param("id") ?? "";
    const input = c.req.valid("json");
    const auth = c.get("auth");
    const { tenantId } = auth;

    if (ENGINE_RELATION_TYPES.has(input.relationType.trim().toLowerCase())) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message:
            "This relation type is managed by the engine: use the children or references endpoints",
          fields: { relationType: "reserved relation type" },
        },
        422,
      );
    }

    // "agent" is a tenant-wide role that already links tickets freely
    // (matches the pre-existing requireRole("admin","agent") contract);
    // only "user" callers are subject to the extra full-access check below —
    // creator, assignee, or workflow admin of the *source* ticket.
    const isAgentOrAdmin =
      auth.roles.includes("admin") || auth.roles.includes("agent");
    const caller = toWorkflowCaller(auth);

    try {
      const relation = await withTenantContext(tenantId, async (tx) => {
        if (!isAgentOrAdmin) {
          await assertRecordWorkflowAccess(
            tx,
            tenantId,
            fromInstanceId,
            caller,
          );
          // A target the caller cannot read answers exactly like a target that
          // does not exist, so the route cannot be used to probe which ticket
          // ids exist in the tenant.
          const target = await getEntity(
            tx,
            tenantId,
            input.toInstanceId,
          ).catch((err: unknown) => {
            // Same name-based check handle-entity-error.ts uses: the engine
            // throws EntityError with code ENTITY_NOT_FOUND for a missing id.
            if (
              err instanceof Error &&
              err.name === "EntityError" &&
              (err as Error & { code?: string }).code === "ENTITY_NOT_FOUND"
            ) {
              throw new TargetUnavailableError();
            }
            throw err;
          });
          const canReadTarget = await hasEntityAccess(
            tx,
            tenantId,
            target,
            auth.userId,
            auth.roles,
          );
          if (!canReadTarget) throw new TargetUnavailableError();
        }
        return createRelation(tx, tenantId, {
          fromInstanceId,
          toInstanceId: input.toInstanceId,
          relationType: input.relationType,
          actorId: auth.userId,
        });
      });
      return c.json({ data: relation }, 201);
    } catch (err) {
      if (err instanceof TargetUnavailableError) {
        // Same body handleEntityError returns for RELATION_TARGET_NOT_FOUND.
        return c.json(
          { error: "RELATION_TARGET_NOT_FOUND", message: "Not found" },
          404,
        );
      }
      return handleEntityError(c, err);
    }
  },
);
