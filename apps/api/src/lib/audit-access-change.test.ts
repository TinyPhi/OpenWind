import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWriteAuditEntry = vi.fn();
vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

const { auditAccessChange, readAccessEntry } =
  await import("./audit-access-change.js");

const TX = { tag: "tx" } as unknown as Parameters<typeof auditAccessChange>[0];

const base = {
  tenantId: "t-1",
  actorId: "u-actor",
  instanceId: "inst-1",
  targetUserId: "u-target",
  via: "direct" as const,
};

describe("auditAccessChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAuditEntry.mockResolvedValue(undefined);
  });

  it("records access.granted when there was no prior entry", async () => {
    const after = { level: "read_only", tag: "manual" };
    await auditAccessChange(TX, { ...base, before: null, after });

    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const [tx, entry] = mockWriteAuditEntry.mock.calls[0];
    expect(tx).toBe(TX);
    expect(entry).toMatchObject({
      tenantId: "t-1",
      actorId: "u-actor",
      actorType: "user",
      resourceType: "ticket",
      resourceId: "inst-1",
      action: "access.granted",
      beforeSnapshot: null,
      afterSnapshot: after,
    });
  });

  it("records access.updated when both before and after exist", async () => {
    await auditAccessChange(TX, {
      ...base,
      before: { level: "read_only", tag: "manual" },
      after: { level: "read_write", tag: "manual" },
    });
    expect(mockWriteAuditEntry.mock.calls[0][1].action).toBe("access.updated");
  });

  it("writes nothing when the entry is unchanged", async () => {
    await auditAccessChange(TX, {
      ...base,
      before: { level: "read_write", tag: "manual" },
      after: { level: "read_write", tag: "manual" },
    });
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("still records a change of tag alone", async () => {
    await auditAccessChange(TX, {
      ...base,
      before: { level: "read_write", tag: "mention" },
      after: { level: "read_write", tag: "manual" },
    });
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry.mock.calls[0][1].action).toBe("access.updated");
  });

  it("records access.revoked when there is no after entry", async () => {
    await auditAccessChange(TX, {
      ...base,
      before: { level: "read_write", tag: "manual" },
      after: null,
    });
    const entry = mockWriteAuditEntry.mock.calls[0][1];
    expect(entry.action).toBe("access.revoked");
    expect(entry.afterSnapshot).toBeNull();
  });

  it("omits requestId and unassigned from metadata when absent", async () => {
    await auditAccessChange(TX, {
      ...base,
      before: null,
      after: { level: "read_only", tag: "manual" },
    });
    const { metadata } = mockWriteAuditEntry.mock.calls[0][1];
    expect(metadata).toEqual({ targetUserId: "u-target", via: "direct" });
    expect(metadata).not.toHaveProperty("requestId");
    expect(metadata).not.toHaveProperty("unassigned");
  });

  it("includes requestId and unassigned when provided", async () => {
    await auditAccessChange(TX, {
      ...base,
      via: "access_request",
      requestId: "req-1",
      unassigned: true,
      before: { level: "read_only", tag: "manual" },
      after: null,
    });
    expect(mockWriteAuditEntry.mock.calls[0][1].metadata).toEqual({
      targetUserId: "u-target",
      via: "access_request",
      requestId: "req-1",
      unassigned: true,
    });
  });

  it("propagates a failed audit write (fail closed)", async () => {
    mockWriteAuditEntry.mockRejectedValue(new Error("db down"));
    await expect(
      auditAccessChange(TX, {
        ...base,
        before: null,
        after: { level: "read_only", tag: "manual" },
      }),
    ).rejects.toThrow("db down");
  });
});

describe("readAccessEntry", () => {
  it("reads level and tag from the map shape", () => {
    expect(
      readAccessEntry(
        { __accessUsers: { u1: { level: "read_write", tag: "mention" } } },
        "u1",
      ),
    ).toEqual({ level: "read_write", tag: "mention" });
  });

  it("defaults tag to manual when missing or not a string", () => {
    expect(
      readAccessEntry({ __accessUsers: { u1: { level: "read_only" } } }, "u1"),
    ).toEqual({ level: "read_only", tag: "manual" });
    expect(
      readAccessEntry(
        { __accessUsers: { u1: { level: "read_only", tag: 5 } } },
        "u1",
      ),
    ).toEqual({ level: "read_only", tag: "manual" });
  });

  it("returns null for the legacy array shape", () => {
    expect(readAccessEntry({ __accessUsers: ["u1"] }, "u1")).toBeNull();
  });

  it("returns null when fields or __accessUsers are missing", () => {
    expect(readAccessEntry(null, "u1")).toBeNull();
    expect(readAccessEntry(undefined, "u1")).toBeNull();
    expect(readAccessEntry({}, "u1")).toBeNull();
    expect(readAccessEntry({ __accessUsers: "nope" }, "u1")).toBeNull();
  });

  it("returns null for a missing user or malformed entry", () => {
    const fields = {
      __accessUsers: {
        u2: { level: "read_only" },
        bad: { level: 3 },
        empty: null,
      },
    };
    expect(readAccessEntry(fields, "u1")).toBeNull();
    expect(readAccessEntry(fields, "bad")).toBeNull();
    expect(readAccessEntry(fields, "empty")).toBeNull();
  });
});
