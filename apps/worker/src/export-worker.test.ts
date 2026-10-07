/**
 * export-worker.test.ts
 *
 * Unit tests for CSV/XLSX formula-injection sanitization (security fix).
 * The BullMQ worker, DB, and local file store are mocked purely so the module can be
 * imported -- these tests exercise the exported renderCsv/renderXlsx/
 * sanitizeSpreadsheetCell functions directly against real csv-stringify /
 * exceljs output, not the queue processor itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";

// ── Mocks (only what's needed to import the module safely) ────────────────────

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

const mockIsTenantActive = vi.fn().mockResolvedValue(true);
vi.mock("@platform/db", () => ({
  withTenantContext: (tenantId: string, fn: (tx: unknown) => unknown) => fn({}),
  isTenantActive: (...args: unknown[]) => mockIsTenantActive(...args),
}));

const mockGetEntityType = vi.fn();
const mockListEntityFields = vi.fn();
const mockListEntities = vi.fn();
vi.mock("@platform/entity-engine", () => ({
  getEntityType: (...args: unknown[]) => mockGetEntityType(...args),
  listEntityFields: (...args: unknown[]) => mockListEntityFields(...args),
  listEntities: (...args: unknown[]) => mockListEntities(...args),
  buildExportRow: vi.fn(() => ["id", "open", "", ""]),
  PII_EXPORT_ROLES: new Set(["pii_export", "admin", "superadmin"]),
}));

const mockWriteAuditEntry = vi.fn();
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

const mockSaveExport = vi.fn().mockResolvedValue("t-aaa/exports/job-1.csv");
vi.mock("@platform/files", () => ({
  saveExport: (...args: unknown[]) => mockSaveExport(...args),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./queues.js", () => ({ connection: {} }));
vi.mock("./render-export-pdf.js", () => ({ renderExportPdf: vi.fn() }));

const { sanitizeSpreadsheetCell, renderCsv, renderXlsx, processExportJob } =
  await import("./export-worker.js");

// ── sanitizeSpreadsheetCell ────────────────────────────────────────────────────

describe("sanitizeSpreadsheetCell", () => {
  it("force-texts a value starting with =", () => {
    expect(sanitizeSpreadsheetCell('=HYPERLINK("http://evil","x")')).toBe(
      '\'=HYPERLINK("http://evil","x")',
    );
  });

  it("force-texts a value starting with @", () => {
    expect(sanitizeSpreadsheetCell("@SUM(1,1)")).toBe("'@SUM(1,1)");
  });

  it("force-texts a value starting with + or -", () => {
    expect(sanitizeSpreadsheetCell("+cmd|'/C calc'!A1")).toBe(
      "'+cmd|'/C calc'!A1",
    );
    expect(sanitizeSpreadsheetCell("-2+3+cmd|' /C calc'!A1")).toBe(
      "'-2+3+cmd|' /C calc'!A1",
    );
  });

  it("force-texts a value starting with a tab character", () => {
    expect(sanitizeSpreadsheetCell("\tcmd|'/C calc'!A1")).toBe(
      "'\tcmd|'/C calc'!A1",
    );
  });

  it("force-texts a value starting with a carriage return", () => {
    expect(sanitizeSpreadsheetCell("\rcmd|'/C calc'!A1")).toBe(
      "'\rcmd|'/C calc'!A1",
    );
  });

  it("leaves an ordinary value untouched", () => {
    expect(sanitizeSpreadsheetCell("Fix the login bug")).toBe(
      "Fix the login bug",
    );
    expect(sanitizeSpreadsheetCell("")).toBe("");
  });
});

// ── renderCsv ───────────────────────────────────────────────────────────────────

describe("renderCsv", () => {
  it("neutralizes a formula-injection payload in a data cell", () => {
    const buf = renderCsv(
      ["Subject"],
      [['=HYPERLINK("http://evil/leak","x")']],
    );
    const text = buf.toString("utf-8");
    expect(text).toContain('"\'=HYPERLINK(""http://evil/leak"",""x"")"');
    expect(text).not.toMatch(/^=HYPERLINK/m);
  });

  it("neutralizes a formula-injection payload in a header cell", () => {
    const buf = renderCsv(["=cmd|'/C calc'!A1"], [["value"]]);
    expect(buf.toString("utf-8")).toContain("'=cmd");
  });

  it("passes ordinary rows through unchanged", () => {
    const buf = renderCsv(["ID", "Subject"], [["1", "Fix the login bug"]]);
    expect(buf.toString("utf-8")).toContain("Fix the login bug");
  });
});

// ── renderXlsx ──────────────────────────────────────────────────────────────────

describe("renderXlsx", () => {
  it("neutralizes a formula-injection payload so the cell is stored as text, not a formula", async () => {
    const buf = await renderXlsx(
      ["Subject"],
      [['=HYPERLINK("http://evil/leak","x")']],
      "TestSheet",
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf);
    const sheet = workbook.getWorksheet("TestSheet");
    const cell = sheet?.getCell("A2");

    // A real formula cell would have cell.type === ValueType.Formula; the
    // sanitized value must round-trip as plain text starting with the
    // escaping apostrophe, not be interpreted as a formula.
    expect(cell?.value).toBe('\'=HYPERLINK("http://evil/leak","x")');
  });

  it("passes ordinary rows through unchanged", async () => {
    const buf = await renderXlsx(
      ["ID", "Subject"],
      [["1", "Fix the login bug"]],
      "TestSheet",
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buf);
    const sheet = workbook.getWorksheet("TestSheet");
    expect(sheet?.getCell("B2").value).toBe("Fix the login bug");
  });
});

// ── processExportJob audit trail (#638) ────────────────────────────────────────

describe("processExportJob — audit trail", () => {
  const TYPE_ID = "00000000-0000-0000-0000-000000000001";
  const job = (roles: string[]) => ({
    id: "job-1",
    data: {
      tenantId: "t-aaa",
      entityTypeId: TYPE_ID,
      format: "csv" as const,
      filters: {},
      requestedBy: "u-bbb",
      requestedByRoles: roles,
    },
  });
  const actions = (): string[] =>
    mockWriteAuditEntry.mock.calls.map(
      // second argument is writeAuditEntry's AuditEntryInput
      (c) => (c[1] as { action: string }).action,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTenantActive.mockResolvedValue(true);
    mockGetEntityType.mockResolvedValue({ id: TYPE_ID, plural: "Tickets" });
    mockListEntityFields.mockResolvedValue([]);
    mockListEntities.mockResolvedValue({ data: [{ id: "i1" }, { id: "i2" }] });
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("audits export.completed with row count and includePii on success", async () => {
    const result = await processExportJob(job(["admin"]));
    expect(result.rowCount).toBe(2);
    expect(result.storageKey).toBe("t-aaa/exports/job-1.csv");
    expect(mockSaveExport).toHaveBeenCalledWith(
      "t-aaa",
      "job-1",
      "csv",
      expect.any(Buffer),
    );
    expect(actions()).toEqual(["export.completed"]);
    expect(mockWriteAuditEntry.mock.calls[0]?.[1]).toMatchObject({
      tenantId: "t-aaa",
      actorId: "u-bbb",
      actorType: "user",
      resourceType: "entity_type",
      resourceId: TYPE_ID,
      metadata: {
        format: "csv",
        mode: "async",
        jobId: "job-1",
        rowCount: 2,
        includePii: true,
      },
    });
  });

  it("records includePii: false for a requester without a PII export role", async () => {
    await processExportJob(job(["agent"]));
    expect(mockWriteAuditEntry.mock.calls[0]?.[1]).toMatchObject({
      metadata: { includePii: false },
    });
  });

  it("audits export.failed and rethrows when the job throws", async () => {
    mockListEntities.mockRejectedValueOnce(new TypeError("db exploded"));
    await expect(processExportJob(job(["agent"]))).rejects.toThrow(
      "db exploded",
    );
    expect(actions()).toEqual(["export.failed"]);
    expect(mockWriteAuditEntry.mock.calls[0]?.[1]).toMatchObject({
      metadata: { error: "JOB_FAILED", jobId: "job-1" },
    });
  });

  it("audits export.failed when the tenant was deactivated before the job ran", async () => {
    mockIsTenantActive.mockResolvedValueOnce(false);
    const result = await processExportJob(job(["agent"]));
    expect(result.error).toBe("TENANT_DEACTIVATED");
    expect(actions()).toEqual(["export.failed"]);
  });

  it("still surfaces the original error when auditing the failure also fails", async () => {
    mockListEntities.mockRejectedValueOnce(new Error("original"));
    mockWriteAuditEntry.mockRejectedValueOnce(new Error("audit down"));
    await expect(processExportJob(job(["agent"]))).rejects.toThrow("original");
  });
});
