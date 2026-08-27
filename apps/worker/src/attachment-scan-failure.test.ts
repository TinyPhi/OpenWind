/**
 * attachment-scan-failure.test.ts
 *
 * Unit tests for handleAttachmentScanFailure. DB is fully mocked -- the
 * real-Postgres path (RLS, the audit CHECK constraint) is covered by
 * apps/api/tests/isolation/attachment-scan-failure.isolation.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAttachmentRow = { value: null as Record<string, unknown> | null };
const mockInstanceRow = { value: null as Record<string, unknown> | null };
const mockInsert = vi
  .fn()
  .mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) });
const mockWriteAuditEntry = vi.fn().mockResolvedValue(undefined);

vi.mock("@platform/db", () => ({
  db: {},
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn(mockTx),
  attachments: { id: "id", filesId: "filesId", tenantId: "tenantId" },
  entityInstances: { id: "id", tenantId: "tenantId" },
  workflowEvents: {},
}));

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let selectCallCount = 0;
const mockTx = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          selectCallCount++;
          // First call resolves the attachments lookup, second the
          // entityInstances lookup -- matches call order in the source file.
          return Promise.resolve(
            selectCallCount === 1
              ? mockAttachmentRow.value
                ? [mockAttachmentRow.value]
                : []
              : mockInstanceRow.value
                ? [mockInstanceRow.value]
                : [],
          );
        },
      }),
    }),
  }),
  insert: (...args: unknown[]) => mockInsert(...args),
};

beforeEach(() => {
  vi.clearAllMocks();
  selectCallCount = 0;
  mockAttachmentRow.value = null;
  mockInstanceRow.value = null;
});

describe("handleAttachmentScanFailure", () => {
  it("is a no-op when the file doesn't back any attachment", async () => {
    const { handleAttachmentScanFailure } =
      await import("./attachment-scan-failure.js");
    mockAttachmentRow.value = null;
    await handleAttachmentScanFailure("tenant-1", "file-1", "quarantined");
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("is a no-op when the attachment was never bound to a ticket", async () => {
    const { handleAttachmentScanFailure } =
      await import("./attachment-scan-failure.js");
    mockAttachmentRow.value = { id: "attach-1", ticketId: null, boundAt: null };
    await handleAttachmentScanFailure("tenant-1", "file-1", "quarantined");
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("writes a system note and audit entry for a quarantined attachment", async () => {
    const { handleAttachmentScanFailure } =
      await import("./attachment-scan-failure.js");
    mockAttachmentRow.value = {
      id: "attach-1",
      ticketId: "ticket-1",
      boundAt: new Date(),
    };
    mockInstanceRow.value = { workflowId: "wf-1", currentState: "open" };

    await handleAttachmentScanFailure("tenant-1", "file-1", "quarantined");

    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        action: "attachment.quarantined",
        resourceId: "ticket-1",
      }),
    );
  });

  it("writes a system note and audit entry for a scan_failed attachment", async () => {
    const { handleAttachmentScanFailure } =
      await import("./attachment-scan-failure.js");
    mockAttachmentRow.value = {
      id: "attach-1",
      ticketId: "ticket-1",
      boundAt: new Date(),
    };
    mockInstanceRow.value = { workflowId: "wf-1", currentState: "open" };

    await handleAttachmentScanFailure("tenant-1", "file-1", "scan_failed");

    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ action: "attachment.scan_failed" }),
    );
  });

  it("is a no-op when the bound ticket itself can't be found", async () => {
    const { handleAttachmentScanFailure } =
      await import("./attachment-scan-failure.js");
    mockAttachmentRow.value = {
      id: "attach-1",
      ticketId: "ticket-1",
      boundAt: new Date(),
    };
    mockInstanceRow.value = null;

    await handleAttachmentScanFailure("tenant-1", "file-1", "quarantined");
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});
