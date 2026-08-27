/**
 * index.test.ts — @platform/audit unit tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("@platform/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@platform/db", () => ({
  adminAuditLog: {
    tenantId: "admin_audit_log.tenant_id",
    actorId: "admin_audit_log.actor_id",
    actorType: "admin_audit_log.actor_type",
    actingPersonId: "admin_audit_log.acting_person_id",
  },
}));

vi.mock("@platform/workflow-engine", () => ({
  redactMetadata: vi.fn(
    (metadata: Record<string, unknown>, map: Map<string, string>) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(metadata)) {
        const sensitivity = map.get(k);
        result[k] =
          sensitivity === "pii" || sensitivity === "financial"
            ? "[REDACTED]"
            : v;
      }
      return result;
    },
  ),
  buildSensitivityMap: vi.fn(
    (fields: Array<{ name: string; sensitivity: string }>) => {
      const map = new Map<string, string>();
      for (const f of fields) {
        if (f.sensitivity === "pii" || f.sensitivity === "financial") {
          map.set(f.name, f.sensitivity);
        }
      }
      return map;
    },
  ),
}));

const mockInsert = vi.fn();
const mockValues = vi.fn().mockResolvedValue(undefined);
mockInsert.mockReturnValue({ values: mockValues });

const mockDb = { insert: mockInsert };

const { writeAuditEntry, anonymizeAuditLogForTenant } =
  await import("./index.js");

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

const BASE_INPUT = {
  tenantId: "tenant-a",
  actorId: "user-b",
  actorType: "user" as const,
  resourceType: "ticket",
  resourceId: "instance-c",
  action: "created" as const,
};

describe("writeAuditEntry", () => {
  it("inserts an audit row with null snapshots for a create action", async () => {
    await writeAuditEntry(mockDb as never, {
      ...BASE_INPUT,
      afterSnapshot: { subject: "hello" },
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "admin_audit_log.tenant_id" }),
    );
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "created",
        afterSnapshot: expect.objectContaining({ subject: "hello" }),
        beforeSnapshot: null,
      }),
    );
  });

  it("redacts pii field values in after_snapshot", async () => {
    await writeAuditEntry(mockDb as never, {
      ...BASE_INPUT,
      action: "updated",
      afterSnapshot: { ssn: "123-45-6789", title: "Engineer" },
      entityFields: [
        { name: "ssn", sensitivity: "pii" },
        { name: "title", sensitivity: "internal" },
      ],
    });

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        afterSnapshot: { ssn: "[REDACTED]", title: "Engineer" },
      }),
    );
  });

  it("redacts financial field values in before_snapshot", async () => {
    await writeAuditEntry(mockDb as never, {
      ...BASE_INPUT,
      action: "updated",
      beforeSnapshot: { salary: 95000, name: "Alice" },
      afterSnapshot: { salary: 100000, name: "Alice" },
      entityFields: [
        { name: "salary", sensitivity: "financial" },
        { name: "name", sensitivity: "public" },
      ],
    });

    const call = mockValues.mock.calls[0]?.[0];
    expect(call?.beforeSnapshot?.salary).toBe("[REDACTED]");
    expect(call?.afterSnapshot?.salary).toBe("[REDACTED]");
    expect(call?.beforeSnapshot?.name).toBe("Alice"); // public — verbatim
  });

  it("passes public and internal field values verbatim", async () => {
    await writeAuditEntry(mockDb as never, {
      ...BASE_INPUT,
      afterSnapshot: { status: "open", note: "internal note" },
      entityFields: [
        { name: "status", sensitivity: "public" },
        { name: "note", sensitivity: "internal" },
      ],
    });

    const call = mockValues.mock.calls[0]?.[0];
    expect(call?.afterSnapshot?.status).toBe("open");
    expect(call?.afterSnapshot?.note).toBe("internal note");
  });

  it("writes null snapshots without redaction when entityFields is omitted", async () => {
    await writeAuditEntry(mockDb as never, {
      ...BASE_INPUT,
      afterSnapshot: { ssn: "123-45-6789" },
      // No entityFields — redaction map is empty
    });

    // Without entityFields, sensitivity map is empty → value passes through
    const call = mockValues.mock.calls[0]?.[0];
    expect(call?.afterSnapshot?.ssn).toBe("123-45-6789");
  });

  it("handles null/undefined snapshots without throwing", async () => {
    await writeAuditEntry(mockDb as never, {
      ...BASE_INPUT,
      beforeSnapshot: null,
      afterSnapshot: null,
    });

    const call = mockValues.mock.calls[0]?.[0];
    expect(call?.beforeSnapshot).toBeNull();
    expect(call?.afterSnapshot).toBeNull();
  });

  it("writes metadata when provided", async () => {
    await writeAuditEntry(mockDb as never, {
      ...BASE_INPUT,
      metadata: { transitionName: "close", triggeredBy: "user" },
    });

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { transitionName: "close", triggeredBy: "user" },
      }),
    );
  });
});

describe("anonymizeAuditLogForTenant", () => {
  const mockUpdateSet = vi.fn();
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdate = vi.fn().mockReturnValue({
    set: (v: unknown) => {
      mockUpdateSet(v);
      return { where: mockUpdateWhere };
    },
  });

  // The implementation now does batched SELECT → UPDATE. Return one batch
  // on the first call, empty on the second to terminate the loop.
  let selectCallCount = 0;
  const mockSelectLimit = vi.fn().mockImplementation(async () => {
    selectCallCount++;
    return selectCallCount === 1 ? [{ id: "row-1" }] : [];
  });
  const mockSelect = vi.fn().mockReturnValue({
    from: () => ({ where: () => ({ limit: mockSelectLimit }) }),
  });

  const mockPurgeDb = { update: mockUpdate, select: mockSelect };

  beforeEach(() => {
    vi.clearAllMocks();
    selectCallCount = 0;
  });

  it("issues batched UPDATEs scoped to the tenant, replacing both person-identifying fields", async () => {
    await anonymizeAuditLogForTenant(mockPurgeDb as never, "tenant-a");

    expect(mockSelect).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "admin_audit_log.tenant_id" }),
    );
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: expect.anything(),
        actingPersonId: expect.anything(),
      }),
    );
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });
});
