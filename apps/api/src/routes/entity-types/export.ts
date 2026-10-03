import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zValidator } from "../../lib/validator.js";
import { requireAuth, requireRole } from "@platform/auth";
import { withTenantContext } from "@platform/db";
import {
  getEntityType,
  listEntityFields,
  listEntities,
  EntityError,
  buildExportRow,
  type EntityField,
} from "@platform/entity-engine";
import { renderExportPdf } from "../../lib/render-export-pdf.js";
import { stringify } from "csv-stringify/sync";
import ExcelJS from "exceljs";
import { exportQueue, PII_EXPORT_ROLES } from "../../lib/export-queue.js";
import { writeAuditEntry } from "@platform/audit";
import type { AuditAction } from "@platform/audit";
import { factory } from "./factory.js";
import { enforceExportRateLimit } from "../../lib/rate-limit-tiers.js";

const SYNC_ROW_LIMIT = 5_000;
const EXPORT_ROW_LIMIT = 10_000;

const ExportQuerySchema = z.object({
  format: z.enum(["csv", "xlsx", "pdf"]),
  // Bounded: the value is also recorded in the export audit entry (#638)
  state: z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  assignedTo: z.string().uuid().optional(),
});

// ── Route handler ─────────────────────────────────────────────────────────────

// #692: keyed on the verified identity, so it sits after requireAuth and
// before anything touches the database.
const exportRateLimit = factory.createMiddleware(async (c, next) => {
  const { tenantId, userId } = c.get("auth");
  const { allowed, resetAt } = await enforceExportRateLimit(tenantId, userId);
  if (!allowed) {
    const retryAfter = Math.max(1, resetAt - Math.ceil(Date.now() / 1000));
    c.header("Retry-After", String(retryAfter));
    return c.json(
      { error: "RATE_LIMITED", message: "Too many export requests" },
      429,
    );
  }
  await next();
  return;
});

export const exportEntitiesHandler = factory.createHandlers(
  requireAuth(),
  exportRateLimit,
  requireRole("agent", "admin"),
  zValidator("query", ExportQuerySchema),
  async (c) => {
    const { tenantId, userId, roles } = c.get("auth");
    const entityTypeId = c.req.param("id") ?? "";
    const { format, state, assignedTo } = c.req.valid("query");
    const filters = {
      ...(state !== undefined && { state }),
      ...(assignedTo !== undefined && { assignedTo }),
    };

    const canSeePii = roles.some((r) => PII_EXPORT_ROLES.has(r));

    const result = await withTenantContext(tenantId, async (tx) => {
      let entityType;
      try {
        entityType = await getEntityType(tx, tenantId, entityTypeId);
      } catch (err) {
        if (
          err instanceof EntityError &&
          err.code === "ENTITY_TYPE_NOT_FOUND"
        ) {
          return null;
        }
        throw err;
      }

      const allFields = await listEntityFields(tx, tenantId, entityTypeId);
      const exportFields: EntityField[] = canSeePii
        ? allFields
        : allFields.filter(
            (f) => f.sensitivity !== "pii" && f.sensitivity !== "financial",
          );

      const page = await listEntities(tx, tenantId, {
        entityTypeId,
        ...filters,
        limit: EXPORT_ROW_LIMIT + 1,
      });

      return { entityType, fields: exportFields, rows: page.data };
    });

    if (!result) {
      return c.json(
        { error: "NOT_FOUND", message: "Entity type not found" },
        404,
      );
    }

    const { entityType, fields, rows } = result;

    if (rows.length > EXPORT_ROW_LIMIT) {
      return c.json(
        {
          error: "EXPORT_TOO_LARGE",
          message: `Export exceeds ${EXPORT_ROW_LIMIT} rows. Apply filters to narrow the result set.`,
        },
        400,
      );
    }

    // #638: every export that proceeds is audited before any data leaves
    // (fail-closed — if this write fails, so does the export). Metadata holds
    // settings and counts only, never row values.
    // assignedTo is a user id — record only that the filter was used, so the
    // audit row holds no person reference tenant-purge anonymization misses.
    const auditFilters = {
      ...(state !== undefined && { state }),
      ...(assignedTo !== undefined && { assignedToFilter: true }),
    };
    const audit = (
      action: AuditAction,
      metadata: Record<string, unknown>,
    ): Promise<void> =>
      withTenantContext(tenantId, (tx) =>
        writeAuditEntry(tx, {
          tenantId,
          actorId: userId,
          actorType: "user",
          resourceType: "entity_type",
          resourceId: entityTypeId,
          action,
          metadata: { format, includePii: canSeePii, ...metadata },
        }),
      );

    // ── Async path ─────────────────────────────────────────────────────────────
    if (rows.length > SYNC_ROW_LIMIT) {
      // Pre-generated so the request entry can name the job before it exists
      const jobId = randomUUID();
      await audit("export.requested", {
        filters: auditFilters,
        rowCount: rows.length,
        mode: "async",
        jobId,
      });
      let job;
      try {
        job = await exportQueue.add(
          "export",
          {
            tenantId,
            entityTypeId,
            format,
            filters,
            requestedBy: userId,
            requestedByRoles: roles,
          },
          { jobId },
        );
      } catch (err) {
        await audit("export.failed", {
          mode: "async",
          jobId,
          rowCount: rows.length,
          error: "ENQUEUE_FAILED",
        });
        throw err;
      }
      if (!job.id) throw new Error("Export job enqueue returned no ID");
      return c.json({ jobId: job.id }, 202);
    }

    // ── Sync path ─────────────────────────────────────────────────────────────
    await audit("export.requested", {
      filters: auditFilters,
      rowCount: rows.length,
      mode: "sync",
    });
    let response: Response;
    try {
      response = await renderSync();
    } catch (err) {
      await audit("export.failed", {
        mode: "sync",
        // Domain codes, not JS class names, so audit queries see one shape.
        error: "RENDER_FAILED",
      });
      throw err;
    }
    await audit("export.completed", { rowCount: rows.length, mode: "sync" });
    return response;

    async function renderSync(): Promise<Response> {
      const dateStr = new Date().toISOString().slice(0, 10);
      const safePlural = entityType.plural
        .replace(/[^a-z0-9]/gi, "-")
        .toLowerCase();
      const headers = [
        "ID",
        "State",
        "Created At",
        "Updated At",
        ...fields.map((f) => f.label),
      ];
      const dataRows = rows.map((r) => buildExportRow(r, fields));

      if (format === "csv") {
        const csvData = stringify([headers, ...dataRows]);
        return c.newResponse(csvData, 200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safePlural}-export-${dateStr}.csv"`,
        });
      }

      if (format === "pdf") {
        const pdfBuffer = await renderExportPdf(
          headers,
          dataRows,
          entityType.plural,
        );
        // Hono's newResponse accepts BodyInit; Buffer is not in that union but
        // works at runtime via Node.js's fetch-compatible body handling.
        return c.newResponse(pdfBuffer as unknown as string, 200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${safePlural}-export-${dateStr}.pdf"`,
        });
      }

      // xlsx
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(entityType.plural.slice(0, 31));
      sheet.addRow(headers);
      const headerRow = sheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.commit();
      for (const row of rows) {
        sheet.addRow(buildExportRow(row, fields));
      }
      for (let i = 1; i <= headers.length; i++) {
        const col = sheet.getColumn(i);
        let maxLen = 10;
        col.eachCell({ includeEmpty: false }, (cell) => {
          const len =
            cell.value !== null && cell.value !== undefined
              ? String(cell.value).length
              : 0;
          if (len > maxLen) maxLen = len;
        });
        col.width = Math.min(maxLen + 2, 50);
      }
      const buffer = await workbook.xlsx.writeBuffer();
      // Same as pdfBuffer cast above — Buffer satisfies BodyInit at runtime.
      return c.newResponse(buffer as unknown as string, 200, {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${safePlural}-export-${dateStr}.xlsx"`,
      });
    }
  },
);
