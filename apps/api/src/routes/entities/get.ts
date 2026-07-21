import { requireAuth } from "@platform/auth";
import { withTenantContext, workflows, entityRelations } from "@platform/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  getEntity,
  getParentId,
  countActiveChildren,
  RELATION_CHILD_OF,
} from "@platform/entity-engine";
import { factory } from "./factory.js";
import { handleEntityError } from "../../lib/handle-entity-error.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

async function getAncestorDepth(
  db: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  tenantId: string,
  instanceId: string,
): Promise<number> {
  let current = instanceId;
  let depth = 0;
  while (depth < 20) {
    const [parentRel] = await db
      .select({ toInstanceId: entityRelations.toInstanceId })
      .from(entityRelations)
      .where(
        and(
          eq(entityRelations.tenantId, tenantId),
          eq(entityRelations.fromInstanceId, current),
          eq(entityRelations.relationType, RELATION_CHILD_OF),
          isNull(entityRelations.deletedAt),
        ),
      )
      .limit(1);
    if (!parentRel) break;
    current = parentRel.toInstanceId;
    depth++;
  }
  return depth;
}

export const getEntityHandler = factory.createHandlers(
  requireAuth(),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId, roles } = c.get("auth");

    try {
      const [instance, parentId, childCount, ancestorDepth] =
        await withTenantContext(tenantId, (tx) =>
          Promise.all([
            getEntity(tx, tenantId, id),
            getParentId(tx, tenantId, id),
            countActiveChildren(tx, tenantId, id),
            getAncestorDepth(tx, tenantId, id),
          ]),
        );

      const allowed = await withTenantContext(tenantId, (tx) =>
        hasEntityAccess(tx, tenantId, instance, userId, roles),
      );
      if (!allowed) {
        return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
      }

      let maxChildDepth = 0;
      if (instance.workflowId) {
        const [wf] = await withTenantContext(tenantId, (tx) =>
          tx
            .select({ maxChildDepth: workflows.maxChildDepth })
            .from(workflows)
            .where(eq(workflows.id, instance.workflowId ?? ""))
            .limit(1),
        );
        maxChildDepth = wf?.maxChildDepth ?? 0;
      }

      const canAddChildren = maxChildDepth > 0 && ancestorDepth < maxChildDepth;

      return c.json({
        data: { ...instance, parentId, childCount, canAddChildren },
      });
    } catch (err) {
      return handleEntityError(c, err);
    }
  },
);
