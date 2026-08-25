// Moved to packages/workflow-engine/src/emit-access-event.ts (ADR-012 Phase C,
// PR #470 review fix) so apps/worker's mention-resolution processor can call
// emitAccessEvent for its own auto-grant path without an apps-to-apps import
// (disallowed by the dependency rule) — same rationale as entity-access.ts's
// earlier move. apps/api/src/lib/emit-access-event.ts now just re-exports
// this file unchanged for its existing call sites.
import { eq, and, isNull } from "drizzle-orm";
import {
  entityInstances,
  entityRelations,
  workflowEvents,
  outboxEvents,
  withTenantContext,
} from "@platform/db";

type AccessEventType =
  | "access_grant"
  | "access_update"
  | "access_revoke"
  | "access_reject";

interface AccessEventPayload {
  type: AccessEventType;
  targetUserId: string;
  targetDisplayName?: string | null;
  level?: string;
  oldLevel?: string;
  tag?: string;
}

// Resolves the workflowId a workflow_events row should be filed under — child
// tickets may have a null workflowId of their own, so this walks up to the
// parent's workflow. Shared by every access-related history writer below (and,
// via the export, by other apps/api history writers needing the same walk —
// e.g. apps/api/src/routes/files/download.ts); returns null (never throws)
// when no instance/workflow can be resolved, so callers can just no-op rather
// than duplicate this walk.
export async function resolveWorkflowContext(
  tenantId: string,
  instanceId: string,
): Promise<{ workflowId: string; currentState: string } | null> {
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

  if (!row) return null;

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

  if (!workflowId) return null;
  return { workflowId, currentState: row.currentState };
}

export async function emitAccessEvent(
  tenantId: string,
  instanceId: string,
  actorId: string,
  payload: AccessEventPayload,
): Promise<void> {
  try {
    const ctx = await resolveWorkflowContext(tenantId, instanceId);
    if (!ctx) return;

    await withTenantContext(tenantId, (tx) =>
      tx.insert(workflowEvents).values({
        tenantId,
        instanceId,
        workflowId: ctx.workflowId,
        fromState: ctx.currentState,
        toState: ctx.currentState,
        triggeredBy: "user",
        actorId,
        comment: null,
        metadata: payload,
      }),
    );

    // access_grant/access_revoke/access_update all map to a notification
    // trigger — access_reject deliberately does not (ui-feature-checklist-and-rules.md
    // §2.10: only the requester is notified of a rejection, and that's driven
    // directly by resolve-access-request.ts's own access_request.updated
    // outbox write, not this generic access-event path).
    const notificationEventType =
      payload.type === "access_grant"
        ? ("access.granted" as const)
        : payload.type === "access_revoke"
          ? ("access.revoked" as const)
          : payload.type === "access_update"
            ? ("access.updated" as const)
            : null;

    if (notificationEventType) {
      await withTenantContext(tenantId, (tx) =>
        tx.insert(outboxEvents).values({
          tenantId,
          eventType: notificationEventType,
          version: 1,
          payload: {
            eventType: notificationEventType,
            version: 1,
            tenantId,
            instanceId,
            actorId,
            targetUserId: payload.targetUserId,
          },
        }),
      );
    }
  } catch {
    // Best-effort — never block the main operation
  }
}

// ui-feature-checklist-and-rules.md §3.6 — the access REQUEST itself (not
// just its eventual approval/rejection, see resolve-access-request.ts) needs
// its own history line: "Priyanka requested read-write access". Deliberately
// not routed through emitAccessEvent/AccessEventType — a request has no
// "target user" distinct from its actor (the requester is requesting for
// themselves), so it gets its own metadata shape rather than forcing a
// targetUserId that would just duplicate actorId.
export async function emitAccessRequestSubmitted(
  tenantId: string,
  instanceId: string,
  requesterId: string,
  requestedLevel: string,
): Promise<void> {
  try {
    const ctx = await resolveWorkflowContext(tenantId, instanceId);
    if (!ctx) return;

    await withTenantContext(tenantId, (tx) =>
      tx.insert(workflowEvents).values({
        tenantId,
        instanceId,
        workflowId: ctx.workflowId,
        fromState: ctx.currentState,
        toState: ctx.currentState,
        triggeredBy: "user",
        actorId: requesterId,
        comment: null,
        metadata: { type: "access_request", level: requestedLevel },
      }),
    );
  } catch {
    // Best-effort — never block the main operation (mirrors emitAccessEvent)
  }
}

// ui-feature-checklist-and-rules.md §3.4 — "this user downloaded this file"
// needs its own history line. Unlike file_attached/file_deleted (already
// wired in create-attachment.ts/delete-attachment.ts, which mutate the
// attachment itself), a download is read-only, so this is new: nothing else
// writes a history row for GET /files/:id today.
export async function emitFileDownloaded(
  tenantId: string,
  instanceId: string,
  actorId: string,
  fileId: string,
  originalName: string,
): Promise<void> {
  try {
    const ctx = await resolveWorkflowContext(tenantId, instanceId);
    if (!ctx) return;

    await withTenantContext(tenantId, (tx) =>
      tx.insert(workflowEvents).values({
        tenantId,
        instanceId,
        workflowId: ctx.workflowId,
        fromState: ctx.currentState,
        toState: ctx.currentState,
        triggeredBy: "user",
        actorId,
        comment: null,
        metadata: { type: "file_downloaded", fileId, originalName },
      }),
    );
  } catch {
    // Best-effort — never block the download itself
  }
}

// ui-feature-checklist-and-rules.md §3.5 — mirrors the same file_deleted
// metadata shape create-attachment.ts's sibling delete-attachment.ts already
// writes for the primary per-ticket attachment-delete UX; this covers the
// separate, lower-level DELETE /files/:id admin endpoint
// (apps/api/src/routes/files/delete.ts), which had no history write at all.
export async function emitFileDeleted(
  tenantId: string,
  instanceId: string,
  actorId: string,
  fileId: string,
  originalName: string,
): Promise<void> {
  try {
    const ctx = await resolveWorkflowContext(tenantId, instanceId);
    if (!ctx) return;

    await withTenantContext(tenantId, (tx) =>
      tx.insert(workflowEvents).values({
        tenantId,
        instanceId,
        workflowId: ctx.workflowId,
        fromState: ctx.currentState,
        toState: ctx.currentState,
        triggeredBy: "user",
        actorId,
        comment: null,
        metadata: { type: "file_deleted", fileId, originalName },
      }),
    );
  } catch {
    // Best-effort — never block the delete itself
  }
}
