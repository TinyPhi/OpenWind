import { describe, it, expect, vi, beforeEach } from "vitest";

// mock bullmq
vi.mock("bullmq", () => ({
  Worker: vi.fn().mockImplementation(function (
    _queue: string,
    _processor: () => Promise<void>,
  ) {
    return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
  }),
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// mock db
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhereSelect = vi.fn();
const mockDelete = vi.fn();
const mockWhereDelete = vi.fn();

mockSelect.mockImplementation(() => ({
  from: mockFrom.mockImplementation(() => ({
    where: mockWhereSelect,
  })),
}));

mockDelete.mockImplementation(() => ({
  where: mockWhereDelete.mockResolvedValue(1),
}));

vi.mock("@platform/db", () => ({
  db: {
    select: mockSelect,
    delete: mockDelete,
  },
  tenants: {
    id: "tenants.id",
    config: "tenants.config",
    status: "tenants.status",
  },
  workflowEvents: {
    tenantId: "workflow_events.tenant_id",
    createdAt: "workflow_events.created_at",
  },
  outboxEvents: {
    tenantId: "outbox_events.tenant_id",
    createdAt: "outbox_events.created_at",
  },
  tenantUsageDaily: {
    tenantId: "tenant_usage_daily.tenant_id",
    usageDate: "tenant_usage_daily.usage_date",
  },
}));

vi.mock("./queues.js", () => ({ connection: {} }));

const { runRetentionArchivalSweep } = await import("./retention-archival.js");

describe("Retention Archival Sweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries tenants and deletes expired records based on configured retention_days", async () => {
    // Mock active tenants
    mockWhereSelect.mockResolvedValueOnce([
      {
        id: "tenant-1",
        config: { retention_days: 30 },
      },
      {
        id: "tenant-2",
        config: {}, // empty config, falls back to 90
      },
    ]);

    await runRetentionArchivalSweep();

    // Verify select was called once to fetch active tenants
    expect(mockSelect).toHaveBeenCalledTimes(1);

    // Verify delete was called 3 times per tenant (6 times total)
    expect(mockDelete).toHaveBeenCalledTimes(6);
  });
});
