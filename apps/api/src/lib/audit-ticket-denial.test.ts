import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWriteAuditEntry = vi.fn();
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

const mockTx = { tag: "tx" };
const mockWithTenantContext = vi.fn(
  (_tenantId: string, fn: (tx: unknown) => unknown) => fn(mockTx),
);
vi.mock("@platform/db", () => ({
  withTenantContext: (tenantId: string, fn: (tx: unknown) => unknown) =>
    mockWithTenantContext(tenantId, fn),
}));

const mockLoggerWarn = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

const { auditTicketAccessDenied } = await import("./audit-ticket-denial.js");

const input = {
  tenantId: "t-1",
  userId: "u-1",
  instanceId: "inst-1",
  action: "ticket.view_denied" as const,
};

describe("auditTicketAccessDenied", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("writes a user/ticket entry with the given action in the tenant context", async () => {
    await auditTicketAccessDenied(input);

    expect(mockWithTenantContext).toHaveBeenCalledWith(
      "t-1",
      expect.any(Function),
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(mockTx, {
      tenantId: "t-1",
      actorId: "u-1",
      actorType: "user",
      resourceType: "ticket",
      resourceId: "inst-1",
      action: "ticket.view_denied",
    });
  });

  it("passes through comment.access_denied", async () => {
    await auditTicketAccessDenied({
      ...input,
      action: "comment.access_denied",
    });
    expect(mockWriteAuditEntry.mock.calls[0][1].action).toBe(
      "comment.access_denied",
    );
  });

  it("swallows a rejected audit write and logs a warning", async () => {
    const boom = new Error("audit down");
    mockWriteAuditEntry.mockRejectedValue(boom);

    await expect(auditTicketAccessDenied(input)).resolves.toBeUndefined();

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [obj] = mockLoggerWarn.mock.calls[0];
    expect(obj).toMatchObject({
      auditErr: boom,
      tenantId: "t-1",
      instanceId: "inst-1",
      action: "ticket.view_denied",
    });
  });

  it("swallows a failure to open the tenant context", async () => {
    mockWithTenantContext.mockRejectedValueOnce(new Error("no conn"));
    await expect(auditTicketAccessDenied(input)).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });
});
