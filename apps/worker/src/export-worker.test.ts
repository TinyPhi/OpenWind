/**
 * export-worker.test.ts
 *
 * Unit tests for CSV/XLSX formula-injection sanitization (security fix).
 * The BullMQ worker, DB, and S3 client are mocked purely so the module can be
 * imported -- these tests exercise the exported renderCsv/renderXlsx/
 * sanitizeSpreadsheetCell functions directly against real csv-stringify /
 * exceljs output, not the queue processor itself.
 */

import { describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";

// ── Mocks (only what's needed to import the module safely) ────────────────────

vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock("@platform/db", () => ({
  withTenantContext: (tenantId: string, fn: (tx: unknown) => unknown) => fn({}),
  isTenantActive: vi.fn().mockResolvedValue(true),
}));

vi.mock("@platform/entity-engine", () => ({
  getEntityType: vi.fn(),
  listEntityFields: vi.fn(),
  listEntities: vi.fn(),
  buildExportRow: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return { send: vi.fn().mockResolvedValue({}) };
  }),
  PutObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://example.com/signed"),
}));

vi.mock("@platform/config", () => ({
  env: {
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "test",
    S3_ACCESS_KEY: "key",
    S3_SECRET_KEY: "secret",
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./queues.js", () => ({ connection: {} }));
vi.mock("./render-export-pdf.js", () => ({ renderExportPdf: vi.fn() }));

const { sanitizeSpreadsheetCell, renderCsv, renderXlsx } =
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
