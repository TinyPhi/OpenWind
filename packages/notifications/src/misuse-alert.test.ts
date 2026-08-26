import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@platform/db", () => ({
  outboxEvents: "outbox_events_mock",
}));

const mockValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
const mockTx = { insert: mockInsert };

const { fireMisuseAlert } = await import("./misuse-alert.js");

describe("fireMisuseAlert", () => {
  beforeEach(() => {
    mockInsert.mockClear();
    mockValues.mockClear();
  });

  it("writes a system.error outbox event, delivered immediately (dead-lettered by design)", async () => {
    await fireMisuseAlert(mockTx as never, "tenant-a", "10 auth failures", {
      trigger: "auth_failure_rate",
      applicationActorId: "key-1",
    });

    expect(mockInsert).toHaveBeenCalledWith("outbox_events_mock");
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        eventType: "system.error",
        version: 1,
        payload: expect.objectContaining({
          eventType: "system.error",
          version: 1,
          tenantId: "tenant-a",
          reason: "10 auth failures",
          context: {
            trigger: "auth_failure_rate",
            applicationActorId: "key-1",
          },
        }),
        deliveredAt: expect.any(Date),
      }),
    );
  });
});
