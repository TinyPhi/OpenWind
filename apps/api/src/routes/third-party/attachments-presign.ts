import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireActingPerson } from "@platform/auth";
import {
  withTenantContext,
  db,
  entityInstances,
  attachments,
} from "@platform/db";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { hasEntityCommentAccessFull } from "../../lib/entity-access.js";

// Mirrors apps/api/src/routes/files/initiate.ts's allowlist -- third-party
// attachments go through the exact same MIME gate as human-UI uploads, no
// separate/weaker list for API callers.
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "application/json",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/zip",
  "application/x-zip-compressed",
]);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB/file (spec R1)
const UPLOAD_SLOT_TTL_MS = 5 * 60 * 1000; // 5 minutes (spec R8)

const PresignAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  mimeType: z.string().min(1),
  ticketId: z.string().uuid().optional(),
});

function notFound(c: {
  json: (body: unknown, status: 404) => Response;
}): Response {
  return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
}

export function hashUploadToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * POST /api/v1/attachments/presign — ADR-012 Phase D, spec R1.
 *
 * `ticketId` is optional (omitted for the create-time-attach case, since the
 * ticket doesn't exist yet). When present, this requires the same
 * comment-access check comment-post uses -- otherwise an authenticated key
 * with no real access to any ticket could mint unbounded storage slots
 * (spec-review blocker, closed).
 */
export const presignAttachmentHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("attach"),
  zValidator("json", PresignAttachmentSchema),
  async (c) => {
    const { tenantId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");
    const input = c.req.valid("json");

    if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
      return c.json(
        {
          error: "VALIDATION_ERROR",
          message: "MIME type is not in the allowed list",
        },
        422,
      );
    }
    if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
      return c.json(
        {
          error: "FILE_TOO_LARGE",
          message: "Declared size exceeds the 10MB per-file limit",
        },
        422,
      );
    }

    const { ticketId } = input;
    if (ticketId) {
      const [instance] = await withTenantContext(tenantId, (tx) =>
        tx
          .select({
            id: entityInstances.id,
            workflowId: entityInstances.workflowId,
            currentState: entityInstances.currentState,
            assignedTo: entityInstances.assignedTo,
            createdBy: entityInstances.createdBy,
            fields: entityInstances.fields,
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
        return notFound(c);
      }
      const allowed = await withTenantContext(tenantId, (tx) =>
        hasEntityCommentAccessFull(tx, tenantId, instance, actingPersonId, []),
      );
      if (!allowed) {
        return notFound(c);
      }
    }

    const uploadToken = randomBytes(32).toString("base64url");
    const uploadExpiresAt = new Date(Date.now() + UPLOAD_SLOT_TTL_MS);

    const [attachment] = await withTenantContext(tenantId, (tx) =>
      tx
        .insert(attachments)
        .values({
          tenantId,
          ticketId: ticketId ?? null,
          uploadedBy: "api_key",
          actingPersonId,
          declaredFilename: input.filename,
          declaredSizeBytes: input.sizeBytes,
          declaredMimeType: input.mimeType,
          uploadTokenHash: hashUploadToken(uploadToken),
          uploadExpiresAt,
          status: "pending",
        })
        .returning({ id: attachments.id }),
    );

    if (!attachment) {
      return c.json(
        {
          error: "INTERNAL_ERROR",
          message: "Failed to create attachment slot",
        },
        500,
      );
    }

    return c.json(
      {
        data: {
          attachmentId: attachment.id,
          uploadUrl: `/api/v1/attachments/${attachment.id}/upload?token=${uploadToken}`,
          expiresAt: uploadExpiresAt.toISOString(),
        },
      },
      201,
    );
  },
);
