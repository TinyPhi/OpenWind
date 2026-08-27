import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireActingPerson } from "@platform/auth";
import { withTenantContext, db, attachments } from "@platform/db";
import { saveUpload, deleteFile, FileError } from "@platform/files";
import { zValidator } from "../../lib/validator.js";
import { factory } from "./factory.js";
import { connection } from "../../lib/redis.js";
import { hashUploadToken } from "./attachments-presign.js";
import { enforceKeyPersonRateLimit } from "../../lib/rate-limit-tiers.js";
import { env } from "@platform/config";
import { applicationActorIdFromUserId } from "../../lib/application-actor-id.js";

const UploadQuerySchema = z.object({
  token: z.string().min(1),
});

function notFound(c: {
  json: (body: unknown, status: 404) => Response;
}): Response {
  return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
}

/**
 * PUT /api/v1/attachments/:id/upload — ADR-012 Phase D, spec R2.
 *
 * Single-use: a completed or expired slot rejects any further PUT (409/410)
 * rather than silently overwriting or re-processing. Raw bytes only -- no
 * JSON/multipart parsing, so the ticket/comment create endpoints never see
 * file content (spec R2, the whole point of this phase).
 *
 * Reuses saveUpload's existing quota-at-write-time enforcement and AV-scan
 * enqueue (@platform/files) rather than duplicating that logic -- this is
 * the same pipeline human-UI uploads go through.
 */
export const uploadAttachmentHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  zValidator("query", UploadQuerySchema),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId, userId: authUserId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");
    const { token } = c.req.valid("query");

    // ADR-012 Phase G, ADR-013 -- this route doesn't go through
    // requireTicketScope (upload is presign-token-gated, not scope-gated),
    // so the per-(key,person) rate-limit tier has to be enforced directly
    // here instead of inheriting it from that middleware.
    const applicationActorId = applicationActorIdFromUserId(authUserId);
    const rateLimit = await enforceKeyPersonRateLimit(
      tenantId,
      applicationActorId,
      actingPersonId,
    );

    c.header(
      "x-ratelimit-key-person-limit",
      String(env.RATE_LIMIT_API_KEY_PERSON_PER_MIN),
    );
    c.header("x-ratelimit-key-person-remaining", String(rateLimit.remaining));
    c.header("x-ratelimit-key-person-reset", String(rateLimit.resetAt));

    if (!rateLimit.allowed) {
      return c.json(
        { error: "RATE_LIMITED", message: "Too many requests" },
        429,
      );
    }

    const [attachment] = await withTenantContext(tenantId, (tx) =>
      tx
        .select()
        .from(attachments)
        .where(and(eq(attachments.id, id), eq(attachments.tenantId, tenantId)))
        .limit(1),
    );

    if (!attachment) {
      return notFound(c);
    }
    const providedHash = Buffer.from(hashUploadToken(token), "hex");
    const storedHash = Buffer.from(attachment.uploadTokenHash, "hex");
    if (
      providedHash.length !== storedHash.length ||
      !timingSafeEqual(providedHash, storedHash)
    ) {
      return notFound(c);
    }
    if (attachment.status === "uploaded" || attachment.status === "uploading") {
      return c.json(
        {
          error: "ALREADY_UPLOADED",
          message: "This upload slot has already been used",
        },
        409,
      );
    }
    if (
      attachment.status === "expired" ||
      attachment.uploadExpiresAt < new Date()
    ) {
      return c.json(
        { error: "UPLOAD_EXPIRED", message: "This upload slot has expired" },
        410,
      );
    }

    // Atomic claim: closes the TOCTOU window where two concurrent PUTs could
    // both pass the read-only checks above and both proceed to saveUpload
    // (double file write, double quota charge, one filesId silently
    // orphaned). Only the request whose UPDATE actually flips pending ->
    // uploading proceeds; a concurrent loser sees 0 rows affected and 409s
    // instead of racing through the upload.
    const [claimed] = await withTenantContext(tenantId, (tx) =>
      tx
        .update(attachments)
        .set({ status: "uploading", updatedAt: new Date() })
        .where(
          and(
            eq(attachments.id, id),
            eq(attachments.tenantId, tenantId),
            eq(attachments.status, "pending"),
          ),
        )
        .returning({ id: attachments.id }),
    );
    if (!claimed) {
      return c.json(
        {
          error: "ALREADY_UPLOADED",
          message: "This upload slot has already been used",
        },
        409,
      );
    }

    const bytes = Buffer.from(await c.req.arrayBuffer());

    if (bytes.byteLength !== attachment.declaredSizeBytes) {
      // Release the claim so a retry with the correct byte count can still
      // succeed before the slot's own expiry. Conditional on tenantId +
      // still-"uploading" so this can't affect another tenant's row, nor
      // resurrect a slot the cleanup sweep already expired concurrently.
      await withTenantContext(tenantId, (tx) =>
        tx
          .update(attachments)
          .set({ status: "pending", updatedAt: new Date() })
          .where(
            and(
              eq(attachments.id, id),
              eq(attachments.tenantId, tenantId),
              eq(attachments.status, "uploading"),
            ),
          ),
      );
      return c.json(
        {
          error: "SIZE_MISMATCH",
          message: "Uploaded byte count does not match the declared size",
        },
        422,
      );
    }

    try {
      const result = await withTenantContext(tenantId, (tx) =>
        saveUpload(
          tx,
          connection,
          tenantId,
          actingPersonId,
          "third-party-attachments",
          attachment.ticketId,
          attachment.declaredFilename,
          attachment.declaredMimeType,
          bytes,
        ),
      );

      // Conditioned on status = 'uploading' (full-phase security review
      // finding): saveUpload above can take long enough for a slow request
      // to cross the slot's own TTL mid-flight, during which
      // attachment-cleanup.ts's sweep could flip this row to 'expired'.
      // Without this guard, this write would silently resurrect an expired
      // slot as 'uploaded' with a real filesId once the request finally
      // finishes — a real TTL bypass, not just a cosmetic race.
      const [finalized] = await withTenantContext(tenantId, (tx) =>
        tx
          .update(attachments)
          .set({
            status: "uploaded",
            filesId: result.fileId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(attachments.id, id),
              eq(attachments.tenantId, tenantId),
              eq(attachments.status, "uploading"),
            ),
          )
          .returning({ id: attachments.id }),
      );

      if (!finalized) {
        // Lost the race to the cleanup sweep -- the file was already saved
        // to disk by saveUpload above, so clean it up rather than leaving
        // an orphaned file with no reachable attachment row.
        await withTenantContext(tenantId, (tx) =>
          deleteFile(tx, tenantId, result.fileId),
        );
        return c.json(
          { error: "UPLOAD_EXPIRED", message: "This upload slot has expired" },
          410,
        );
      }

      return c.json(
        { data: { attachmentId: id, status: result.scanStatus } },
        201,
      );
    } catch (err: unknown) {
      // Release the claim on failure so the slot isn't permanently stuck in
      // 'uploading' until its natural expiry. Conditional on tenantId +
      // still-"uploading", same rationale as the size-mismatch release above.
      await withTenantContext(tenantId, (tx) =>
        tx
          .update(attachments)
          .set({ status: "pending", updatedAt: new Date() })
          .where(
            and(
              eq(attachments.id, id),
              eq(attachments.tenantId, tenantId),
              eq(attachments.status, "uploading"),
            ),
          ),
      );
      if (err instanceof FileError) {
        switch (err.code) {
          case "FILE_TOO_LARGE":
            return c.json(
              { error: err.code, message: "File exceeds the allowed size" },
              422,
            );
          case "QUOTA_EXCEEDED":
            return c.json(
              { error: err.code, message: "Storage quota exceeded" },
              422,
            );
        }
      }
      throw err;
    }
  },
);
