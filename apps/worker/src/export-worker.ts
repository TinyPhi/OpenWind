/**
 * export-worker.ts
 *
 * BullMQ processor for the "export" queue.
 *
 * For each job:
 *  1. Fetch entity type + fields from the DB (honouring includePii from payload)
 *  2. Stream entity rows up to EXPORT_ROW_LIMIT
 *  3. Render CSV, xlsx, or PDF into a Buffer
 *  4. Upload to S3 at exports/{tenantId}/{jobId}.{format}
 *  5. Generate a presigned GET URL valid for 1 h
 *  6. Return { downloadUrl, format, rowCount } as the job return value
 *     — the polling endpoint reads this via queue.getJob(id).returnvalue
 */

import { Worker } from "bullmq";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import ExcelJS from "exceljs";
import { stringify } from "csv-stringify/sync";
import { withTenantContext } from "@platform/db";
import { validateActiveTenant } from "./tenant-guard.js";
import {
  getEntityType,
  listEntityFields,
  listEntities,
  buildExportRow,
  type ExportJobPayload,
  type ExportJobResult,
  PII_EXPORT_ROLES,
} from "@platform/entity-engine";
import { renderExportPdf } from "./render-export-pdf.js";
import { env } from "@platform/config";
import { logger } from "@platform/logger";
import { connection } from "./queues.js";

const EXPORT_ROW_LIMIT = 10_000;
const DOWNLOAD_URL_TTL_SECONDS = 3_600; // 1 h

// ── S3 clients ────────────────────────────────────────────────────────────────
// Two clients are needed when S3_ENDPOINT is an internal Docker hostname:
//   getS3()          — internal endpoint, used for the PutObjectCommand upload
//   getS3ForSigning() — public endpoint (S3_PUBLIC_URL ?? S3_ENDPOINT), used only
//                       for presigning so the signature embeds the browser-accessible
//                       host. Matches packages/files/src/index.ts's identical fix —
//                       signing against the internal endpoint produced download URLs
//                       unreachable from the browser wherever the two endpoints differ.

let _s3: S3Client | undefined;
function getS3(): S3Client {
  _s3 ??= new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: "us-east-1",
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
    forcePathStyle: true,
  });
  return _s3;
}

let _s3Signing: S3Client | undefined;
function getS3ForSigning(): S3Client {
  const publicEndpoint = env.S3_PUBLIC_URL ?? env.S3_ENDPOINT;
  if (_s3Signing === undefined || publicEndpoint !== env.S3_ENDPOINT) {
    _s3Signing = new S3Client({
      endpoint: publicEndpoint,
      region: "us-east-1",
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
      forcePathStyle: true,
    });
  }
  return _s3Signing;
}

// ── Renderers ─────────────────────────────────────────────────────────────────

// A cell starting with any of these is interpreted as a formula by Excel/
// LibreOffice/Google Sheets on open (CSV/XLSX formula injection). A leading
// apostrophe is the standard mitigation -- it forces the cell to text.
// Tradeoff: a legitimate value starting with "-" or "+" (e.g. a negative
// number rendered as a string) also gets force-texted; accepted, since this
// is the same blanket mitigation widely used elsewhere (e.g. GitHub/GitLab
// CSV export) and correctness of a cosmetic number format is secondary to
// not executing attacker-controlled formulas on the viewer's machine.
const FORMULA_INJECTION_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export function sanitizeSpreadsheetCell(value: string): string {
  if (FORMULA_INJECTION_PREFIXES.some((p) => value.startsWith(p))) {
    return `'${value}`;
  }
  return value;
}

function sanitizeRow(row: string[]): string[] {
  return row.map(sanitizeSpreadsheetCell);
}

export function renderCsv(headers: string[], rows: string[][]): Buffer {
  const safeHeaders = sanitizeRow(headers);
  const safeRows = rows.map(sanitizeRow);
  return Buffer.from(stringify([safeHeaders, ...safeRows]), "utf-8");
}

export async function renderXlsx(
  headers: string[],
  rows: string[][],
  sheetName: string,
): Promise<Buffer> {
  const safeHeaders = sanitizeRow(headers);
  const safeRows = rows.map(sanitizeRow);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31));
  sheet.addRow(safeHeaders);
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.commit();
  for (const row of safeRows) {
    sheet.addRow(row);
  }
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ── Worker ────────────────────────────────────────────────────────────────────

export const exportWorker = new Worker<ExportJobPayload, ExportJobResult>(
  "export",
  async (job) => {
    const {
      tenantId,
      entityTypeId,
      format,
      filters,
      requestedByRoles,
      includePii: legacyIncludePii,
    } = job.data;

    logger.info(
      { tenantId, entityTypeId, format, jobId: job.id },
      "export job started",
    );

    const active = await validateActiveTenant(tenantId, "export job", {
      entityTypeId,
      jobId: job.id,
    });
    if (!active) {
      return {
        downloadUrl: "",
        error: "TENANT_DEACTIVATED",
        format,
        rowCount: 0,
      };
    }

    const result = await withTenantContext(tenantId, async (tx) => {
      const entityType = await getEntityType(tx, tenantId, entityTypeId);
      const allFields = await listEntityFields(tx, tenantId, entityTypeId);

      // Determine includePii in the worker by checking requestedByRoles against PII_EXPORT_ROLES
      const includePii =
        legacyIncludePii ??
        requestedByRoles?.some((r) => PII_EXPORT_ROLES.has(r)) ??
        false;
      const exportFields = includePii
        ? allFields
        : allFields.filter(
            (f) => f.sensitivity !== "pii" && f.sensitivity !== "financial",
          );

      const page = await listEntities(tx, tenantId, {
        entityTypeId,
        ...filters,
        limit: EXPORT_ROW_LIMIT,
      });

      return { entityType, fields: exportFields, rows: page.data };
    });

    const { entityType, fields, rows } = result;
    const headers = [
      "ID",
      "State",
      "Created At",
      "Updated At",
      ...fields.map((f) => f.label),
    ];
    const dataRows = rows.map((r) => buildExportRow(r, fields));

    let fileBuffer: Buffer;
    let contentType: string;
    let ext: string;

    if (format === "csv") {
      fileBuffer = renderCsv(headers, dataRows);
      contentType = "text/csv";
      ext = "csv";
    } else if (format === "pdf") {
      fileBuffer = await renderExportPdf(headers, dataRows, entityType.plural);
      contentType = "application/pdf";
      ext = "pdf";
    } else {
      fileBuffer = await renderXlsx(headers, dataRows, entityType.plural);
      contentType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      ext = "xlsx";
    }

    const storageKey = `exports/${tenantId}/${job.id}.${ext}`;

    await getS3().send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: storageKey,
        Body: fileBuffer,
        ContentType: contentType,
      }),
    );

    const downloadUrl = await getSignedUrl(
      getS3ForSigning(),
      new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: storageKey }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );

    logger.info(
      { tenantId, entityTypeId, jobId: job.id, rowCount: rows.length },
      "export job completed",
    );

    return { downloadUrl, format, rowCount: rows.length };
  },
  {
    connection,
    concurrency: 3,
    removeOnComplete: { age: 3_600 },
    removeOnFail: { age: 86_400 },
  },
);

export function stopExportWorker(): Promise<void> {
  return exportWorker.close();
}
