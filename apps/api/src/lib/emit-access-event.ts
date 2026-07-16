import { eq, and, isNull } from "drizzle-orm";
import {
  entityInstances,
  entityRelations,
  workflowEvents,
  withTenantContext,
} from "@platform/db";

type AccessEventType = "access_grant" | "access_update" | "access_revoke";

interface AccessEventPayload {
  type: AccessEventType;
  targetUserId: string;
  targetDisplayName?: string | null;
  level?: string;
  oldLevel?: string;
  tag?: string;
}

export async function emitAccessEvent(
  tenantId: string,
  instanceId: string,
  actorId: string,
  payload: AccessEventPayload,
): Promise<void> {
  try {
    // Resolve workflowId — child tickets may have null; walk up to parent.
    const [row] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
          workflowId: entityInstances.workflowId,
          currentState: entityInstances.currentState,
        })
        .from(entityInstances)
        .where(
          and(
            eq(entityInstances.id, instanceId),
            eq(entityInstances.tenantId, tenantId),
          ),
        )
        .limit(1),
    );

    if (!row) return;

    let workflowId = row.workflowId;
    if (!workflowId) {
      const [parentRel] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({ toInstanceId: entityRelations.toInstanceId })
          .from(entityRelations)
          .where(
            and(
              eq(entityRelations.fromInstanceId, instanceId),
              eq(entityRelations.tenantId, tenantId),
              eq(entityRelations.relationType, "child_of"),
              isNull(entityRelations.deletedAt),
            ),
          )
          .limit(1),
      );
      if (parentRel) {
        const [parent] = await withTenantContext(tenantId, (tx) =>
          tx
            .select({ workflowId: entityInstances.workflowId })
            .from(entityInstances)
            .where(
              and(
                eq(entityInstances.id, parentRel.toInstanceId),
                eq(entityInstances.tenantId, tenantId),
              ),
            )
            .limit(1),
        );
        workflowId = parent?.workflowId ?? null;
      }
    }

    if (!workflowId) return;

    await withTenantContext(tenantId, (tx) =>
      tx.insert(workflowEvents).values({
        tenantId,
        instanceId,
        workflowId,
        fromState: row.currentState,
        toState: row.currentState,
        triggeredBy: "user",
        actorId,
        comment: null,
        metadata: payload,
      }),
    );
  } catch {
    // Best-effort — never block the main operation
  }
}
