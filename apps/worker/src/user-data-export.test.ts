import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("bullmq", () => ({
  Queue: vi.fn(),
  Worker: vi.fn().mockImplementation(function () {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

const mockWriteAuditEntry = vi.fn();
const mockCollect = vi.fn();
const mockSaveExport = vi.fn();
const mockActive = vi.fn();

vi.mock("@platform/db", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => fn({}),
}));
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...a: unknown[]) => mockWriteAuditEntry(...a),
}));
vi.mock("@platform/config", () => ({
  env: {
    USER_EXPORT_ROW_LIMIT: 500,
    USER_EXPORT_INCLUDE_AUDIT: false,
    USER_EXPORT_TTL_DAYS: 3,
  },
}));
vi.mock("@platform/entity-engine", () => ({
  collectUserDataBundle: (...a: unknown[]) => mockCollect(...a),
  serializeUserDataBundle: () => Buffer.from("{}"),
  isUserDataExportPayload: (d: { kind?: string }) => d.kind === "user_data",
  getEntityType: vi.fn(),
  listEntityFields: vi.fn(),
  listEntities: vi.fn(),
  buildExportRow: vi.fn(),
  PII_EXPORT_ROLES: new Set(),
}));
vi.mock("@platform/files", () => ({
  USER_DATA_EXPORT_JOB_PREFIX: "userdata-",
  saveExport: (...a: unknown[]) => mockSaveExport(...a),
}));
vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./tenant-guard.js", () => ({
  validateActiveTenant: (...a: unknown[]) => mockActive(...a),
}));
vi.mock("./queues.js", () => ({ connection: {} }));
vi.mock("./render-export-pdf.js", () => ({ renderExportPdf: vi.fn() }));

const { processUserDataExportJob } = await import("./user-data-export.js");
const { processExportQueueJob } = await import("./export-worker.js");

const EXPORT_ID = "00000000-0000-4000-a000-000000000642";
const JOB_ID = `userdata-${EXPORT_ID}`;
const data = {
  kind: "user_data" as const,
  tenantId: "tenant-aaa",
  subjectUserId: "u-subject",
  requestedBy: "u-admin",
};

const audits = (): Array<Record<string, unknown>> =>
  mockWriteAuditEntry.mock.calls.map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  mockActive.mockResolvedValue(true);
  mockWriteAuditEntry.mockResolvedValue(undefined);
  mockSaveExport.mockResolvedValue(`tenant-aaa/exports/${JOB_ID}.json`);
  mockCollect.mockResolvedValue({
    metadata: { truncated: [] },
    data: { a: [{}, {}], b: [{}] },
  });
});

describe("processUserDataExportJob", () => {
  it("collects with the configured limits, saves JSON and audits completion", async () => {
    const result = await processUserDataExportJob({ id: JOB_ID, data });
    expect(mockCollect).toHaveBeenCalledWith(
      {},
      {
        tenantId: "tenant-aaa",
        userId: "u-subject",
        rowLimit: 500,
        includeAudit: false,
        ttlDays: 3,
      },
    );
    expect(mockSaveExport).toHaveBeenCalledWith(
      "tenant-aaa",
      JOB_ID,
      "json",
      expect.any(Buffer),
    );
    expect(result).toEqual({
      storageKey: `tenant-aaa/exports/${JOB_ID}.json`,
      format: "json",
      rowCount: 3,
    });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      action: "export.completed",
      resourceType: "user_data_export",
      resourceId: EXPORT_ID,
      actorId: "u-admin",
      metadata: { rowCount: 3, subjectUserId: "u-subject" },
    });
  });

  it("never puts bundle contents in the audit entry", async () => {
    mockCollect.mockResolvedValue({
      metadata: { truncated: [] },
      data: { a: [{ secretValue: "do-not-log" }] },
    });
    await processUserDataExportJob({ id: JOB_ID, data });
    expect(JSON.stringify(audits())).not.toContain("do-not-log");
  });

  it("returns TENANT_DEACTIVATED and audits failure without collecting", async () => {
    mockActive.mockResolvedValue(false);
    const result = await processUserDataExportJob({ id: JOB_ID, data });
    expect(result.error).toBe("TENANT_DEACTIVATED");
    expect(mockCollect).not.toHaveBeenCalled();
    expect(audits()[0]).toMatchObject({ action: "export.failed" });
  });

  it("audits JOB_FAILED and rethrows when collection throws", async () => {
    mockCollect.mockRejectedValue(new Error("db"));
    await expect(
      processUserDataExportJob({ id: JOB_ID, data }),
    ).rejects.toThrow("db");
    expect(audits()[0]).toMatchObject({
      action: "export.failed",
      metadata: { error: "JOB_FAILED" },
    });
  });

  it("refuses a job id outside the userdata- namespace", async () => {
    await expect(
      processUserDataExportJob({ id: "plain-1", data }),
    ).rejects.toThrow();
    expect(mockSaveExport).not.toHaveBeenCalled();
  });
});

describe("processExportQueueJob dispatch", () => {
  it("routes user_data payloads to the user-data processor", async () => {
    const result = await processExportQueueJob({ id: JOB_ID, data });
    expect(result.format).toBe("json");
    expect(mockCollect).toHaveBeenCalled();
  });
});
