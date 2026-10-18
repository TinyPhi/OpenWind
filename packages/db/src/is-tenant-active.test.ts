import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLimit = vi.fn();
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock("postgres", () => ({
  default: () => {
    const client = Object.assign(() => undefined, {
      options: { parsers: {}, serializers: {} },
      reserve: vi.fn(),
    });
    return client;
  },
}));

vi.mock("@platform/config", () => ({
  env: {
    DATABASE_URL: "postgres://app_user:pw@pgbouncer:5432/platform",
    DATABASE_POOL_MAX: 10,
    DATABASE_LOCK_POOL_MAX: 5,
  },
}));

vi.mock("@platform/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("drizzle-orm/postgres-js", () => ({
  drizzle: () => ({
    select: mockSelect,
  }),
}));

const { isTenantActive } = await import("./client.js");

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

describe("isTenantActive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false for invalid or missing tenant UUID", async () => {
    expect(await isTenantActive("")).toBe(false);
    expect(await isTenantActive("invalid-uuid")).toBe(false);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("returns false when tenant is not found in database", async () => {
    mockLimit.mockResolvedValueOnce([]);
    const result = await isTenantActive(VALID_UUID);
    expect(result).toBe(false);
  });

  it("returns true when tenant is active with no trial period (trialEndsAt is null)", async () => {
    mockLimit.mockResolvedValueOnce([{ id: VALID_UUID, trialEndsAt: null }]);
    const result = await isTenantActive(VALID_UUID);
    expect(result).toBe(true);
  });

  it("returns true when tenant is active and trialEndsAt is in the future", async () => {
    const futureDate = new Date(Date.now() + 86_400_000);
    mockLimit.mockResolvedValueOnce([
      { id: VALID_UUID, trialEndsAt: futureDate },
    ]);
    const result = await isTenantActive(VALID_UUID);
    expect(result).toBe(true);
  });

  it("returns false when tenant is active but trialEndsAt is in the past (#835)", async () => {
    const pastDate = new Date(Date.now() - 60_000);
    mockLimit.mockResolvedValueOnce([
      { id: VALID_UUID, trialEndsAt: pastDate },
    ]);
    const result = await isTenantActive(VALID_UUID);
    expect(result).toBe(false);
  });
});
