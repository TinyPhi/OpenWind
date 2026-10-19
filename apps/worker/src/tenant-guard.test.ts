import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIsTenantActive = vi.fn();
vi.mock("@platform/db", () => ({
  isTenantActive: (tenantId: string) => mockIsTenantActive(tenantId),
}));

const mockLoggerWarn = vi.fn();
vi.mock("@platform/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

const { validateActiveTenant } = await import("./tenant-guard.js");

describe("validateActiveTenant (#835)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when tenant is active and trial has not expired", async () => {
    mockIsTenantActive.mockResolvedValueOnce(true);

    const result = await validateActiveTenant("tenant-1", "test-worker", {
      jobId: "job-1",
    });

    expect(result).toBe(true);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockIsTenantActive).toHaveBeenCalledWith("tenant-1");
  });

  it("returns false and logs warning when tenant is inactive or trial expired", async () => {
    mockIsTenantActive.mockResolvedValueOnce(false);

    const result = await validateActiveTenant("tenant-expired", "test-worker", {
      jobId: "job-2",
    });

    expect(result).toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-expired",
        workerName: "test-worker",
        jobId: "job-2",
      }),
      "test-worker: aborting execution — tenant is deactivated, trial-expired, or missing",
    );
  });
});
