import { eq, and, inArray, isNull } from "drizzle-orm";
import type { DbOrTx } from "@platform/db";
import { attachments, withTenantContext } from "@platform/db";
import { writeAuditEntry } from "@platform/audit";
import { logger } from "@platform/logger";

export const MAX_ATTACHMENTS_PER_TICKET = 10;

export class AttachmentReferenceError extends Error {
  constructor(
    public readonly status: 404 | 422,
    public readonly body: { error: string; message: string },
  ) {
    super(body.message);
    this.name = "AttachmentReferenceError";
  }
}

/**
 * ADR-012 Phase D, spec R3 — validates a set of attachmentIds can legally be
 * referenced by `ticketId`, then binds any not-yet-bound ones to it.
 *
 * Must run inside the same transaction as the ticket/comment create it
 * accompanies (thrown errors roll back the whole operation, so a rejected
 * attachment reference never leaves a half-created ticket/comment behind).
 *
 * Binding rules (spec R3):
 *  - An attachment whose upload never completed (status !== 'uploaded') is
 *    rejected -- 422.
 *  - An attachment already bound (boundAt set) to a DIFFERENT ticket is
 *    rejected -- 422. Re-referencing the same ticket it's already bound to
 *    is a no-op success (idempotent retry).
 *  - An attachment presigned with a ticketId that doesn't match this
 *    reference's ticketId is rejected BEFORE binding -- 422 (closes the
 *    "presigned for ticket A, referenced from ticket B" gap named in
 *    spec-review).
 *  - Cross-tenant attachment IDs are rejected as 404 (not-403 convention).
 *  - An attachment uploaded by a different acting person than the one making
 *    this reference call is rejected -- 404 (not-403, same convention as
 *    cross-tenant: otherwise the response itself would confirm the ID
 *    belongs to *someone's* attachment, just not this caller's). This check
 *    only gates a NEW binding -- it's skipped once boundAt is already set to
 *    this exact ticket, so the idempotent-retry path above stays reachable
 *    by any ticket-authorized caller, not just the original uploader.
 */
export async function referenceAttachments(
  tx: DbOrTx,
  tenantId: string,
  ticketId: string,
  attachmentIds: string[],
  actingPersonId: string,
  applicationActorId: string,
): Promise<void> {
  try {
    await doReferenceAttachments(
      tx,
      tenantId,
      ticketId,
      attachmentIds,
      actingPersonId,
      applicationActorId,
    );
  } catch (err) {
    // Only the 404 (existence-oracle) throws represent an actual access
    // denial (spec AC4) -- the 422 throws are business-validation rejections
    // of an already-authorized reference, same distinction transitions.ts
    // draws between its access-denied branch and downstream 409/422s. `tx`
    // is mid-rollback by the time we're here (the caller's withTenantContext
    // will discard it), so this needs its OWN transaction, same as
    // transitions.ts's denied-branch audit write.
    if (err instanceof AttachmentReferenceError && err.status === 404) {
      try {
        await withTenantContext(tenantId, (auditTx) =>
          writeAuditEntry(auditTx, {
            tenantId,
            actorId: applicationActorId,
            actorType: "api_key",
            actingPersonId,
            resourceType: "ticket",
            resourceId: ticketId,
            action: "attachment.reference_denied",
            metadata: { attachmentIds },
          }),
        );
      } catch (auditErr) {
        logger.warn(
          { auditErr, tenantId, ticketId },
          "third-party attachment-reference: denied-attempt audit write failed",
        );
      }
    }
    throw err;
  }
}

async function doReferenceAttachments(
  tx: DbOrTx,
  tenantId: string,
  ticketId: string,
  attachmentIds: string[],
  actingPersonId: string,
  applicationActorId: string,
): Promise<void> {
  if (attachmentIds.length === 0) return;
  // Dedup before the length/bind checks -- a client-side duplicate ID must
  // never count twice against MAX_ATTACHMENTS_PER_TICKET, and must never
  // reach the bind loop twice (the second occurrence would find boundAt
  // already set by the first and roll back the whole create/comment on an
  // accidental repeat, not a real conflict).
  const uniqueIds = Array.from(new Set(attachmentIds));
  if (uniqueIds.length > MAX_ATTACHMENTS_PER_TICKET) {
    throw new AttachmentReferenceError(422, {
      error: "TOO_MANY_ATTACHMENTS",
      message: `A ticket may reference at most ${MAX_ATTACHMENTS_PER_TICKET} attachments`,
    });
  }

  const rows = await tx
    .select()
    .from(attachments)
    .where(
      and(
        inArray(attachments.id, uniqueIds),
        eq(attachments.tenantId, tenantId),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const toBind: string[] = [];
  for (const id of uniqueIds) {
    const row = byId.get(id);
    if (!row) {
      throw new AttachmentReferenceError(404, {
        error: "NOT_FOUND",
        message: "Record not found",
      });
    }
    if (row.status !== "uploaded") {
      throw new AttachmentReferenceError(422, {
        error: "ATTACHMENT_NOT_READY",
        message: "This attachment's upload has not completed",
      });
    }
    if (row.boundAt) {
      if (row.ticketId !== ticketId) {
        throw new AttachmentReferenceError(422, {
          error: "ATTACHMENT_ALREADY_BOUND",
          message: "This attachment is already attached to a different ticket",
        });
      }
      // Already bound to this exact ticket -- idempotent no-op. Checked
      // BEFORE the ownership check below: once an attachment is legitimately
      // bound to this ticket, anyone with access to re-reference it (e.g. a
      // retried request) must still hit this no-op, not a spurious 404 --
      // the ownership check exists to gate NEW bindings, not to re-litigate
      // ownership of an already-settled one.
      continue;
    }
    if (row.actingPersonId !== actingPersonId) {
      throw new AttachmentReferenceError(404, {
        error: "NOT_FOUND",
        message: "Record not found",
      });
    }
    if (row.ticketId && row.ticketId !== ticketId) {
      throw new AttachmentReferenceError(422, {
        error: "ATTACHMENT_TICKET_MISMATCH",
        message: "This attachment was presigned for a different ticket",
      });
    }
    toBind.push(id);
  }

  for (const id of toBind) {
    // Conditional on bound_at IS NULL -- same atomic-claim discipline as the
    // upload endpoint's pending->uploading step, so two concurrent
    // create/comment calls referencing the same unbound attachment can't
    // both believe they won the bind.
    const [claimed] = await tx
      .update(attachments)
      .set({ ticketId, boundAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.tenantId, tenantId),
          isNull(attachments.boundAt),
        ),
      )
      .returning({ id: attachments.id, boundAt: attachments.boundAt });
    if (!claimed) {
      throw new AttachmentReferenceError(422, {
        error: "ATTACHMENT_ALREADY_BOUND",
        message: "This attachment is already attached to a different ticket",
      });
    }
  }

  // Same transaction as the binds above -- atomic with the mutation it
  // describes, per @platform/audit's own contract. Written once per call
  // (not per attachment) for both a fresh bind and an idempotent re-reference
  // of an already-bound attachment, since both are a successful "reference"
  // outcome from the caller's perspective.
  await writeAuditEntry(tx, {
    tenantId,
    actorId: applicationActorId,
    actorType: "api_key",
    actingPersonId,
    resourceType: "ticket",
    resourceId: ticketId,
    action: "attachment.referenced",
    metadata: { attachmentIds: uniqueIds },
  });
}
