import { describe, it, expect, vi, beforeEach } from "vitest";
import { alignRotationCursor } from "./rotation-windows.js";

const mockUpdateSet = vi.fn().mockReturnThis();
const mockUpdateWhere = vi.fn().mockResolvedValue([]);
const mockSelectFrom = vi.fn().mockReturnThis();
const mockSelectWhere = vi.fn().mockReturnThis();
const mockSelectLimit = vi.fn();
const mockWriteAuditEntry = vi.fn().mockResolvedValue(undefined);

vi.mock("@platform/audit", () => ({
  writeAuditEntry: (...args: unknown[]) => mockWriteAuditEntry(...args),
}));

describe("rotation-windows alignRotationCursor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectFrom.mockReturnValue({
      where: mockSelectWhere,
    });
    mockSelectWhere.mockReturnValue({
      limit: mockSelectLimit,
    });
  });

  const makeTx = (rotation: unknown, tenantSetting?: unknown) => {
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => {
              // If it's querying rotation
              if (
                typeof table === "object" &&
                table !== null &&
                "cycleDays" in (table as Record<string, unknown>)
              ) {
                return Promise.resolve(rotation ? [rotation] : []);
              }
              // Else tenantSettings
              return Promise.resolve(tenantSetting ? [tenantSetting] : []);
            },
          }),
        }),
      }),
      update: () => ({
        set: mockUpdateSet.mockReturnValue({
          where: mockUpdateWhere,
        }),
      }),
    } as any;
  };

  it("updates cycleDays when window duration is an exact whole-day cycle in timezone", async () => {
    const rotation = {
      id: "rot-1",
      cycleDays: 7,
      nextStartsAt: new Date("2026-06-01T00:00:00Z"),
    };
    const tx = makeTx(rotation);
    const window = {
      id: "win-1",
      rotationId: "rot-1",
      startsAt: new Date("2026-06-01T00:00:00Z"),
      endsAt: new Date("2026-06-15T00:00:00Z"), // 14 days
    } as any;

    await alignRotationCursor(tx, "t-1", "u-1", window, "UTC");

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleDays: 14,
        nextStartsAt: window.endsAt,
      }),
    );
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        resourceType: "on_call_rotation",
        action: "updated",
        afterSnapshot: { cycleDays: 14, nextStartsAt: window.endsAt },
      }),
    );
  });

  it("preserves previous cycleDays when window is not a whole-day cycle (e.g. 7 days + 30 min)", async () => {
    const rotation = {
      id: "rot-1",
      cycleDays: 7,
      nextStartsAt: new Date("2026-06-01T00:00:00Z"),
    };
    const tx = makeTx(rotation);
    const window = {
      id: "win-1",
      rotationId: "rot-1",
      startsAt: new Date("2026-06-01T00:00:00Z"),
      endsAt: new Date("2026-06-08T00:30:00Z"), // 7 days + 30 min
    } as any;

    await alignRotationCursor(tx, "t-1", "u-1", window, "UTC");

    // cycleDays remains 7, not recognized as whole cycle
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleDays: 7,
        nextStartsAt: window.endsAt,
      }),
    );
  });

  it("recognizes 23-hour DST spring-forward window as a 7-day cycle in zone", async () => {
    // 2026-03-08 spring-forward in America/New_York (2:00 -> 3:00)
    // 2026-03-05 05:00 UTC (00:00 EST) to 2026-03-12 04:00 UTC (00:00 EDT) = 7 calendar days = 167 hours
    const startsAt = new Date("2026-03-05T05:00:00Z");
    const endsAt = new Date("2026-03-12T04:00:00Z"); // 7 calendar days, 167 hours
    const rotation = {
      id: "rot-1",
      cycleDays: 14,
      nextStartsAt: startsAt,
    };
    const tx = makeTx(rotation);
    const window = {
      id: "win-1",
      rotationId: "rot-1",
      startsAt,
      endsAt,
    } as any;

    await alignRotationCursor(tx, "t-1", "u-1", window, "America/New_York");

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleDays: 7,
        nextStartsAt: endsAt,
      }),
    );
  });
});
