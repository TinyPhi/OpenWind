import { Readable } from "node:stream";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireActingPerson } from "@platform/auth";
import {
  withTenantContext,
  db,
  attachments,
  entityInstances,
} from "@platform/db";
import { getFileStream, FileError } from "@platform/files";
import { factory } from "./factory.js";
import { requireTicketScope } from "./require-ticket-scope.js";
import { hasEntityAccess } from "../../lib/entity-access.js";

function notFound(c: {
  json: (body: unknown, status: 404) => Response;
}): Response {
  return c.json({ error: "NOT_FOUND", message: "Record not found" }, 404);
}

/**
 * GET /api/v1/attachments/:id/download — ADR-012 Phase D, spec R4/R6/R7.
 *
 * Never streams a `scanning`/`quarantined` attachment (R4) -- getFileStream
 * already throws FileError('FILE_PENDING_SCAN'|'FILE_QUARANTINED') for
 * those, mapped to 404 here (not-403 convention, and avoids revealing scan
 * state to a caller who might not otherwise have access). An unbound
 * attachment (never successfully referenced by a ticket) has no access
 * model to check against, so it's rejected the same way.
 */
export const downloadAttachmentHandler = factory.createHandlers(
  requireAuth(db),
  requireActingPerson(),
  requireTicketScope("read"),
  async (c) => {
    const id = c.req.param("id") ?? "";
    const { tenantId } = c.get("auth");
    const { userId: actingPersonId } = c.get("actingPerson");

    const [attachment] = await withTenantContext(tenantId, (tx) =>
      tx
        .select()
        .from(attachments)
        .where(and(eq(attachments.id, id), eq(attachments.tenantId, tenantId)))
        .limit(1),
    );

    const { filesId, boundAt, ticketId } = attachment ?? {};
    if (!filesId || !boundAt || !ticketId) {
      return notFound(c);
    }

    const [instance] = await withTenantContext(tenantId, (tx) =>
      tx
        .select({
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
      hasEntityAccess(tx, tenantId, instance, actingPersonId, []),
    );
    if (!allowed) {
      return notFound(c);
    }

    try {
      const result = await withTenantContext(tenantId, (tx) =>
        getFileStream(tx, tenantId, filesId),
      );

      // Same sanitization as apps/api/src/routes/files/download.ts (spec R6):
      // strip characters that break/inject the header, and bidi-override
      // characters that can visually disguise the extension.
      const safeFilename = result.originalName
        .replace(/[\r\n"]/g, "_")
        .replace(/[‎‏‪-‮]/g, "");

      // Always "attachment" (never inline) -- the third-party API has no
      // browser-preview use case, so there's no reason to ever render a
      // response body directly (sidesteps the SVG-active-content concern
      // the human-UI route has to special-case entirely).
      c.header("Content-Type", result.mimeType);
      c.header("Content-Length", String(result.sizeBytes));
      c.header(
        "Content-Disposition",
        `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(result.originalName)}`,
      );
      // spec R7 -- prevents a served file executing as active content in a
      // browser, on top of the header sanitization above.
      c.header("Content-Security-Policy", "sandbox");
      return c.body(Readable.toWeb(result.stream) as ReadableStream);
    } catch (err: unknown) {
      if (err instanceof FileError) {
        switch (err.code) {
          case "FILE_NOT_FOUND":
          case "FILE_PENDING_SCAN":
          case "FILE_QUARANTINED":
          case "FILE_SCAN_FAILED":
            return notFound(c);
        }
      }
      throw err;
    }
  },
);
