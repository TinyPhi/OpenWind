/**
 * attachment-scan-failure.ts
 *
 * ADR-012 Phase D, spec R5 — when an AV scan quarantines or fails a file
 * that backs a bound third-party attachment, this writes a durable trail:
 * an automatic system note on the ticket the attachment is bound to, plus
 * an audit log entry. The third-party API caller is never actively
 * notified (its create/comment call already returned success before the
 * scan ran) -- no new webhook/notification channel is built for this case.
 *
 * Called from av-scan.ts's quarantine branch and its final-attempt
 * scan_failed handler. A no-op if the file isn't backing any attachment
 * (i.e. an ordinary human-UI upload) or the attachment was never bound to
 * a ticket.
 */

import { eq, and } from "drizzle-orm";
import {
  attachments,
  entityInstances,
  workflowEvents,
  withTenantContext,
} from "@platform/db";
import { writeAuditEntry, type AuditAction } from "@platform/audit";
import { logger } from "@platform/logger";

export type ScanFailureReason = "quarantined" | "scan_failed";

export async function handleAttachmentScanFailure(
  tenantId: string,
  fileId: string,
  reason: ScanFailureReason,
): Promise<void> {
  const [attachment] = await withTenantContext(tenantId, (tx) =>
    tx
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.filesId, fileId),
          eq(attachments.tenantId, tenantId),
        ),
      )
      .limit(1),
  );

  // Not a third-party attachment (an ordinary human-UI upload), or never
  // successfully bound to a ticket -- nothing to note or audit here.
  if (!attachment?.ticketId || !attachment.boundAt) {
    return;
  }
  const { ticketId } = attachment;

  const [instance] = await withTenantContext(tenantId, (tx) =>
    tx
      .select({
        workflowId: entityInstances.workflowId,
        currentState: entityInstances.currentState,
      })
      .from(entityInstances)
      .where(
        and(
          eq(entityInstances.id, ticketId),
          eq(entityInstances.tenantId, tenantId),
        ),
      )
      .limit(1),
  );
  if (!instance?.workflowId) {
    logger.warn(
      { tenantId, fileId, attachmentId: attachment.id, ticketId },
      "attachment-scan-failure: bound ticket not found — skipping system note",
    );
    return;
  }

  const noteText =
    reason === "quarantined"
      ? "An attached file failed antivirus scanning and was quarantined."
      : "An attached file could not be scanned for viruses after repeated attempts.";

  const action: AuditAction =
    reason === "quarantined"
      ? "attachment.quarantined"
      : "attachment.scan_failed";

  // System-note + audit entry share ONE transaction (PrabhuVijit round-2
  // review, PR #475) -- writing them separately would let one succeed and
  // the other fail independently, leaving a ticket-timeline note with no
  // audit trail or an audit entry with no visible timeline note. Mirrors
  // the same fix already applied to the third-party transition route
  // (apps/api/src/routes/third-party/transitions.ts).
  await withTenantContext(tenantId, async (tx) => {
    await tx.insert(workflowEvents).values({
      tenantId,
      instanceId: ticketId,
      workflowId: instance.workflowId as string, // guarded null-checked above; TS can't narrow through drizzle select shape
      fromState: instance.currentState,
      toState: instance.currentState,
      triggeredBy: "system",
      actorId: "system",
      comment: null,
      metadata: {
        type: "system_note",
        text: noteText,
        reason: `attachment_${reason}`,
        attachmentId: attachment.id,
      },
    });

    await writeAuditEntry(tx, {
      tenantId,
      actorId: "system",
      actorType: "system",
      resourceType: "ticket",
      resourceId: ticketId,
      action,
      metadata: { attachmentId: attachment.id, fileId },
    });
  });

  logger.info(
    { tenantId, fileId, attachmentId: attachment.id, ticketId, reason },
    "attachment-scan-failure: system note + audit entry written",
  );
}
